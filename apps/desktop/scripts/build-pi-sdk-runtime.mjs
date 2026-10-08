import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(desktopDir, "..", "..");
const outputRoot = path.join(desktopDir, "build", "pi-sdk-runtime");
const workspaceFile = path.join(repoDir, "pnpm-workspace.yaml");
const workspace = YAML.parse(readFileSync(workspaceFile, "utf8"));
const sdkCatalog = workspace.catalogs?.["pi-sdk"];
const bundle = JSON.parse(
  readFileSync(path.join(repoDir, "packages", "pi-sdk-runtime-bundle", "package.json"), "utf8"),
);
const desktopPackage = JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8"));
const sdkVersion = sdkCatalog?.["@earendil-works/pi-coding-agent"];
const appMajorVersion = Number(/^\d+/.exec(desktopPackage.version)?.[0]);
if (!sdkVersion || !Number.isInteger(appMajorVersion)) {
  throw new Error("The Pi SDK catalog or desktop app version is invalid.");
}

const runtimeDirectory = path.join(outputRoot, sdkVersion);
const archivePath = path.join(outputRoot, `pi-sdk-runtime-${sdkVersion}.tgz`);
const bootstrapArchivePath = path.join(outputRoot, "runtime.tgz");
const digestPath = `${bootstrapArchivePath}.sha256`;
mkdirSync(outputRoot, { recursive: true });
if (!existsSync(path.join(runtimeDirectory, "node_modules"))) {
  mkdirSync(path.dirname(runtimeDirectory), { recursive: true });
  const relativeTarget = path.relative(repoDir, runtimeDirectory);
  const pnpmBinary = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(
    pnpmBinary,
    [
      "--filter",
      "@pi-gui/pi-sdk-runtime-bundle",
      "deploy",
      "--prod",
      "--legacy",
      "--config.allow-unused-patches=true",
      relativeTarget,
    ],
    {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
      shell: process.platform === "win32",
    },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0 || result.error) {
    throw result.error ?? new Error(`pnpm deploy exited with status ${result.status}.`);
  }
}

const packages = Object.fromEntries(
  Object.keys(bundle.dependencies)
    .filter((name) => name.startsWith("@earendil-works/"))
    .map((name) => [name, sdkCatalog[name]]),
);
const manifest = {
  runtimeApiVersion: 1,
  sdkVersion,
  appMajorVersion,
  packages,
};
writeFileSync(
  path.join(runtimeDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const { verifyPiSdkRuntimeDirectory } = await import(
  pathToFileURL(path.join(repoDir, "packages", "pi-sdk-driver", "dist", "sdk-runtime.js")).href
);
await verifyPiSdkRuntimeDirectory(runtimeDirectory);

const { createPiSdkRuntimeArchive } = await import(
  pathToFileURL(path.join(repoDir, "packages", "pi-sdk-driver", "dist", "sdk-runtime-manager.js"))
    .href
);
const digest = await createPiSdkRuntimeArchive(runtimeDirectory, archivePath);
copyFileSync(archivePath, bootstrapArchivePath);
writeFileSync(digestPath, `sha256:${digest}\n`);
console.log(`Built external Pi SDK ${sdkVersion} runtime (${archivePath})`);
