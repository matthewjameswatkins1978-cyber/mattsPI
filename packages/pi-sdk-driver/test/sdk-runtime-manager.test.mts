import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAndStagePiSdkRuntimeUpdate,
  createPiSdkRuntimeArchive,
  markPiSdkRuntimeHealthy,
  preparePiSdkRuntime,
} from "../dist/sdk-runtime-manager.js";

const sdkPackages = [
  "@earendil-works/chord",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-codemode",
  "@earendil-works/pi-mcp",
  "@earendil-works/pi-telemetry",
  "@earendil-works/pi-tui",
] as const;

test("seed, stage, activate next launch, and roll back an unconfirmed runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "gary-pi-sdk-update-"));
  try {
    const resources = join(root, "resources");
    const runtimeRoot = join(root, "profile", "pi-sdk");
    await mkdir(resources, { recursive: true });
    const seed = join(root, "seed");
    await createFakeRuntime(seed, "1.1.0", 1);
    const bootstrapArchivePath = join(resources, "runtime.tgz");
    const seedDigest = await createPiSdkRuntimeArchive(seed, bootstrapArchivePath);
    const bootstrapDigestPath = `${bootstrapArchivePath}.sha256`;
    await writeFile(bootstrapDigestPath, `sha256:${seedDigest}\n`);

    const options = { runtimeRoot, appVersion: "1.0.1", bootstrapArchivePath, bootstrapDigestPath };
    assert.deepEqual(await preparePiSdkRuntime(options), {
      directory: runtimeRoot,
      version: "1.1.0",
    });
    await markPiSdkRuntimeHealthy(runtimeRoot, "1.1.0");

    const next = join(root, "next");
    await createFakeRuntime(next, "1.2.0", 1);
    const updateArchive = join(root, "update.tgz");
    const digest = await createPiSdkRuntimeArchive(next, updateArchive);
    const archiveBytes = await readFile(updateArchive);
    const fetcher: typeof fetch = async (input) => {
      if (String(input).endsWith("/latest")) {
        return Response.json({
          draft: false,
          prerelease: false,
          assets: [
            {
              name: "pi-sdk-runtime-1.2.0.tgz",
              browser_download_url:
                "https://github.com/minghinmatthewlam/pi-gui/releases/download/v1/pi-sdk-runtime-1.2.0.tgz",
              digest: `sha256:${digest}`,
            },
          ],
        });
      }
      return new Response(archiveBytes);
    };
    const staged = await checkAndStagePiSdkRuntimeUpdate({
      ...options,
      releasesUrl: "https://api.github.com/repos/test/latest",
      fetcher,
    });
    assert.deepEqual(staged, { status: "staged", currentVersion: "1.1.0", version: "1.2.0" });
    assert.equal(
      JSON.parse(await readFile(join(runtimeRoot, "current.json"), "utf8")).directory,
      "1.1.0",
    );

    assert.deepEqual(await preparePiSdkRuntime(options), {
      directory: runtimeRoot,
      version: "1.2.0",
    });
    assert.equal(
      JSON.parse(await readFile(join(runtimeRoot, "activation.json"), "utf8")).previousDirectory,
      "1.1.0",
    );

    // Simulate a process crash before markPiSdkRuntimeHealthy: next launch restores the prior runtime.
    assert.deepEqual(await preparePiSdkRuntime(options), {
      directory: runtimeRoot,
      version: "1.1.0",
    });
    assert.equal(
      JSON.parse(await readFile(join(runtimeRoot, "current.json"), "utf8")).directory,
      "1.1.0",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bad release integrity or app compatibility leaves the active runtime unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "gary-pi-sdk-reject-update-"));
  try {
    const runtimeRoot = join(root, "profile", "pi-sdk");
    const seed = join(root, "seed");
    await createFakeRuntime(seed, "1.1.0", 1);
    const bootstrapArchivePath = join(root, "runtime.tgz");
    const digest = await createPiSdkRuntimeArchive(seed, bootstrapArchivePath);
    const bootstrapDigestPath = `${bootstrapArchivePath}.sha256`;
    await writeFile(bootstrapDigestPath, `sha256:${digest}\n`);
    const options = { runtimeRoot, appVersion: "1.0.1", bootstrapArchivePath, bootstrapDigestPath };
    await preparePiSdkRuntime(options);
    await markPiSdkRuntimeHealthy(runtimeRoot, "1.1.0");

    const incompatible = join(root, "incompatible");
    await createFakeRuntime(incompatible, "1.2.0", 2);
    const archivePath = join(root, "incompatible.tgz");
    await createPiSdkRuntimeArchive(incompatible, archivePath);
    const bytes = await readFile(archivePath);
    const result = await checkAndStagePiSdkRuntimeUpdate({
      ...options,
      releasesUrl: "https://api.github.com/repos/test/latest",
      fetcher: async (input) =>
        String(input).endsWith("/latest")
          ? Response.json({
              assets: [
                {
                  name: "pi-sdk-runtime-1.2.0.tgz",
                  browser_download_url:
                    "https://github.com/minghinmatthewlam/pi-gui/releases/download/v1/pi-sdk-runtime-1.2.0.tgz",
                  digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
                },
              ],
            })
          : new Response(bytes),
    });
    assert.equal(result.status, "failed");
    assert.match(result.message, /supports app major 2/);
    assert.equal(
      JSON.parse(await readFile(join(runtimeRoot, "current.json"), "utf8")).directory,
      "1.1.0",
    );
    await assert.rejects(readFile(join(runtimeRoot, "pending.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createFakeRuntime(
  directory: string,
  version: string,
  appMajorVersion: number,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const packages = Object.fromEntries(sdkPackages.map((name) => [name, version]));
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({ runtimeApiVersion: 1, sdkVersion: version, appMajorVersion, packages }),
  );
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "fake-runtime" }));
  for (const packageName of sdkPackages) {
    const packageDirectory = join(directory, "node_modules", ...packageName.split("/"));
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({
        name: packageName,
        version,
        type: "module",
        exports: { ".": "./index.js" },
      }),
    );
    const api = packageName.endsWith("pi-coding-agent")
      ? "export class SessionManager {}\nexport const ModelRuntime = { create() {} };\nexport const CURRENT_SESSION_VERSION = 3;\n"
      : packageName.endsWith("chord")
        ? "export function createFacetHost() {}\n"
        : "export const runtimeMarker = true;\n";
    await writeFile(join(packageDirectory, "index.js"), api);
  }
}
