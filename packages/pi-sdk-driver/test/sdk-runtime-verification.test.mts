import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPiSdkRuntimeDirectory } from "../dist/sdk-runtime.js";

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

await test("managed runtime guard rejects a missing runtime manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "gary-pi-sdk-missing-runtime-"));
  try {
    const runtime = join(root, "runtime");
    await mkdir(runtime);
    await assert.rejects(verifyPiSdkRuntimeDirectory(runtime), /manifest\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("managed runtime guard rejects an SDK family that disagrees with its manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "gary-pi-sdk-mismatched-runtime-"));
  try {
    const runtime = join(root, "runtime");
    await createRuntime(runtime, "1.2.0", { packageVersion: "1.1.0" });
    await assert.rejects(
      verifyPiSdkRuntimeDirectory(runtime),
      /Managed Pi SDK package .* does not match 1\.2\.0/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("managed runtime guard accepts a coherent newer SDK family with the supported runtime API", async () => {
  const root = await mkdtemp(join(tmpdir(), "gary-pi-sdk-compatible-runtime-"));
  try {
    const runtime = join(root, "runtime");
    await createRuntime(runtime, "1.2.0");
    await assert.rejects(
      verifyPiSdkRuntimeDirectory(runtime, "1.1.0"),
      /does not match expected catalog version 1\.1\.0/,
    );
    const verified = await verifyPiSdkRuntimeDirectory(runtime, "1.2.0");
    assert.equal(verified.manifest.sdkVersion, "1.2.0");
    assert.equal(typeof verified.codingAgent.SessionManager, "function");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createRuntime(
  directory: string,
  sdkVersion: string,
  options: { readonly runtimeApiVersion?: number; readonly packageVersion?: string } = {},
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const packages = Object.fromEntries(sdkPackages.map((name) => [name, sdkVersion]));
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      runtimeApiVersion: options.runtimeApiVersion ?? 1,
      sdkVersion,
      appMajorVersion: 1,
      packages,
    }),
  );
  for (const name of sdkPackages) {
    const packageDirectory = join(directory, "node_modules", ...name.split("/"));
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({
        name,
        version: options.packageVersion ?? sdkVersion,
        type: "module",
        exports: { ".": "./index.js" },
      }),
    );
    const api =
      name === "@earendil-works/pi-coding-agent"
        ? "export class SessionManager {}\nexport const ModelRuntime = { create() {} };\nexport const CURRENT_SESSION_VERSION = 3;\n"
        : name === "@earendil-works/chord"
          ? "export function createFacetHost() {}\n"
          : "export const runtimeMarker = true;\n";
    await writeFile(join(packageDirectory, "index.js"), api);
  }
}
