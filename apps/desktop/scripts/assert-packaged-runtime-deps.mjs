import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const requiredPackages = [
  // Keep packaging-sensitive runtime transitive deps explicit; electron-builder
  // can omit hoisted pnpm dependencies even when local development resolves them.
  "@anthropic-ai/sdk",
  "@earendil-works/chord",
  "@pi-gui/extension-ui",
  "@aws-crypto/sha256-browser",
  "@aws-crypto/sha256-js",
  "@aws-sdk/client-bedrock-runtime",
  "@aws-sdk/core",
  "@aws-sdk/credential-provider-node",
  "@aws-sdk/eventstream-handler-node",
  "@aws-sdk/middleware-eventstream",
  "@aws-sdk/middleware-websocket",
  "@aws-sdk/nested-clients",
  "@aws-sdk/signature-v4-multi-region",
  "@aws-sdk/token-providers",
  "@aws-sdk/types",
  "@aws-sdk/xml-builder",
  "@aws/lambda-invoke-store",
  "@google/genai",
  "@mistralai/mistralai",
  "@opentelemetry/api",
  "@silvia-odwyer/photon-node",
  "@smithy/core",
  "@smithy/credential-provider-imds",
  "@smithy/fetch-http-handler",
  "@smithy/is-array-buffer",
  "@smithy/node-http-handler",
  "@smithy/property-provider",
  "@smithy/shared-ini-file-loader",
  "@smithy/signature-v4",
  "@smithy/types",
  "@smithy/util-buffer-from",
  "@smithy/util-utf8",
  "@xterm/addon-clipboard",
  "@xterm/addon-fit",
  "@xterm/addon-web-links",
  "@xterm/xterm",
  "ansi-regex",
  "balanced-match",
  "bowser",
  "brace-expansion",
  "chalk",
  "cross-spawn",
  "data-uri-to-buffer",
  "diff",
  "glob",
  "highlight.js",
  "hosted-git-info",
  "http-proxy-agent",
  "https-proxy-agent",
  "ignore",
  "jiti",
  "lru-cache",
  "mime-types",
  "minimatch",
  "node-pty",
  "openai",
  "parse5",
  "parse5-htmlparser2-tree-adapter",
  "path-key",
  "partial-json",
  "proper-lockfile",
  "proxy-agent",
  "retry",
  "semver",
  "tar",
  "shebang-command",
  "strip-ansi",
  "tslib",
  "typebox",
  "undici",
  "which",
  "yaml",
  "yargs",
];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const packagePlatform = (process.env.PI_APP_PACKAGE_PLATFORM ?? process.platform)
  .trim()
  .toLowerCase();
const releaseDir = path.resolve(desktopDir, process.env.PI_APP_TEST_RELEASE_DIR ?? "release");
const asarPath = resolveAsarPath(releaseDir, packagePlatform);
const notificationHelperPath =
  packagePlatform === "darwin"
    ? path.join(
        releaseDir,
        "mac-arm64",
        "pi-gui.app",
        "Contents",
        "MacOS",
        "pi-gui-notification-status-helper",
      )
    : undefined;
const pnpmBinary = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const piCodingAgentPackageName = "@earendil-works/pi-coding-agent";
const chordPackageName = "@earendil-works/chord";
const workspaceManifest = YAML.parse(
  readFileSync(path.resolve(desktopDir, "../..", "pnpm-workspace.yaml"), "utf8"),
);
const requiredChordVersion = String(
  workspaceManifest.catalogs?.["pi-sdk"]?.[chordPackageName] ?? "",
);
const requiredPiCodingAgentVersion = String(
  workspaceManifest.catalogs?.["pi-sdk"]?.[piCodingAgentPackageName] ?? "",
);
if (!requiredChordVersion || !requiredPiCodingAgentVersion) {
  throw new Error("The pnpm pi-sdk catalog must declare the Pi SDK runtime versions.");
}
const modelChecks = [
  ...["openai", "openai-codex", "github-copilot"].flatMap((provider) =>
    ["sol", "luna"].map((variant) => ({
      provider,
      id: `gpt-6-${variant}`,
      reason: "Pi SDK GPT-6 support",
      requireReasoning: true,
      requireImageInput: true,
      requireMaxThinking: true,
    })),
  ),
  ...["luna", "sol", "terra"].map((variant) => ({
    provider: "openai-codex",
    id: `gpt-5.6-${variant}`,
    reason: "GPT 5.6 Codex support",
    requireReasoning: true,
    requireImageInput: true,
    requireMaxThinking: true,
  })),
  {
    provider: "anthropic",
    id: "claude-opus-4-7",
    reason: "issue #12 Opus 4.7 visibility",
    requireReasoning: true,
    requireImageInput: true,
  },
  {
    provider: "zai",
    id: "glm-5.3",
    reason: "issue #12 GLM visibility",
    requireReasoning: true,
    requireImageInput: false,
  },
];
const packagedRuntimeImportChecks = [
  ["@pi-gui", "extension-ui", "dist", "transport.js"],
  ["@pi-gui", "extension-ui", "dist", "frame-bridge.js"],
  ["proxy-agent", "dist", "index.js"],
];

if (!existsSync(asarPath)) {
  throw new Error(`Packaged app.asar not found at ${asarPath}. Run the packaging step first.`);
}

if (notificationHelperPath && !existsSync(notificationHelperPath)) {
  throw new Error(`Packaged app is missing notification helper: ${notificationHelperPath}`);
}

const extractedDir = mkdtempSync(path.join(tmpdir(), "pi-gui-packaged-runtime-"));
let cleanupError;
try {
  execFileSync(pnpmBinary, ["exec", "asar", "extract", asarPath, extractedDir], {
    cwd: desktopDir,
    stdio: "pipe",
    shell: process.platform === "win32",
  });

  verifyRequiredPackages(extractedDir);
  verifyNoEmbeddedPiRuntime(extractedDir);
  verifyPackagedChordVersion(extractedDir);
  await verifyPackagedRuntimeImports(extractedDir);
  await verifyPiSdkRuntimeResources(path.dirname(asarPath));
  await verifyNativeNodePty(asarPath);
} finally {
  try {
    rmSync(extractedDir, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 5 : 0,
      retryDelay: process.platform === "win32" ? 200 : 0,
    });
  } catch (error) {
    if (process.platform === "win32") {
      console.warn(`Warning: could not remove temp dir ${extractedDir}: ${error.message}`);
    } else {
      cleanupError = error;
    }
  }
}

// Preserve a verification failure if cleanup also failed.
if (cleanupError) throw cleanupError;

console.log(`Verified packaged runtime dependencies in ${asarPath}`);

function resolveAsarPath(releaseDir, packagePlatform) {
  if (packagePlatform === "darwin") {
    return path.join(releaseDir, "mac-arm64", "pi-gui.app", "Contents", "Resources", "app.asar");
  }

  if (packagePlatform === "linux") {
    const unpackedAsarPath = readdirSync(releaseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^linux(?:-[\w]+)?-unpacked$/.test(entry.name))
      .map((entry) => path.join(releaseDir, entry.name, "resources", "app.asar"))
      .find((candidatePath) => existsSync(candidatePath));

    if (unpackedAsarPath) {
      return unpackedAsarPath;
    }

    return path.join(releaseDir, "linux-unpacked", "resources", "app.asar");
  }

  if (packagePlatform === "win32") {
    const unpackedAsarPath = readdirSync(releaseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^win(?:-[\w]+)?-unpacked$/.test(entry.name))
      .map((entry) => path.join(releaseDir, entry.name, "resources", "app.asar"))
      .find((candidatePath) => existsSync(candidatePath));

    if (unpackedAsarPath) {
      return unpackedAsarPath;
    }

    return path.join(releaseDir, "win-unpacked", "resources", "app.asar");
  }

  throw new Error(`Unsupported packaged runtime dependency target: ${packagePlatform}`);
}

function verifyRequiredPackages(extractedDir) {
  const missingPackages = requiredPackages.filter(
    (packageName) => !existsSync(path.join(extractedDir, "node_modules", packageName)),
  );

  if (missingPackages.length > 0) {
    throw new Error(`Packaged app is missing runtime dependencies: ${missingPackages.join(", ")}`);
  }
}

function verifyNoEmbeddedPiRuntime(extractedDir) {
  const embeddedRuntime = path.join(
    extractedDir,
    "node_modules",
    ...piCodingAgentPackageName.split("/"),
  );
  if (existsSync(embeddedRuntime)) {
    throw new Error(
      "Packaged app embeds Pi Coding Agent; the external runtime must be authoritative.",
    );
  }
}

function verifyPackagedChordVersion(extractedDir) {
  const packagePath = path.join(
    extractedDir,
    "node_modules",
    ...chordPackageName.split("/"),
    "package.json",
  );
  const actualVersion = JSON.parse(readFileSync(packagePath, "utf8")).version;
  if (actualVersion !== requiredChordVersion) {
    throw new Error(
      `Renderer Chord ${actualVersion} does not match Pi SDK catalog ${requiredChordVersion}.`,
    );
  }
}

async function verifyPiSdkRuntimeResources(resourcesDir) {
  const archivePath = path.join(resourcesDir, "pi-sdk-runtime", "runtime.tgz");
  const digestPath = `${archivePath}.sha256`;
  if (!existsSync(archivePath) || !existsSync(digestPath)) {
    throw new Error(`Packaged Pi SDK runtime seed is missing under ${path.dirname(archivePath)}.`);
  }
  const digestText = readFileSync(digestPath, "utf8").trim();
  const expectedDigest = /^sha256:([a-f0-9]{64})$/i.exec(digestText)?.[1]?.toLowerCase();
  const actualDigest = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (!expectedDigest || expectedDigest !== actualDigest) {
    throw new Error("Packaged Pi SDK runtime seed failed SHA-256 verification.");
  }

  const runtimeDirectory = mkdtempSync(path.join(tmpdir(), "pi-gui-external-sdk-runtime-"));
  try {
    const driverRoot = path.resolve(desktopDir, "../../packages/pi-sdk-driver");
    const { x: extractTar } = createRequire(path.join(driverRoot, "package.json"))("tar");
    await extractTar({
      cwd: runtimeDirectory,
      file: archivePath,
      strict: true,
      preservePaths: false,
    });
    const { verifyPiSdkRuntimeDirectory } = await import(
      pathToFileURL(path.join(driverRoot, "dist", "sdk-runtime.js")).href
    );
    const { manifest, codingAgent } = await verifyPiSdkRuntimeDirectory(runtimeDirectory);
    if (manifest.sdkVersion !== requiredPiCodingAgentVersion) {
      throw new Error(
        `External runtime has ${manifest.sdkVersion}; the Pi SDK catalog requires ${requiredPiCodingAgentVersion}.`,
      );
    }
    await verifyRuntimeModels(codingAgent.ModelRuntime);
  } finally {
    rmSync(runtimeDirectory, { recursive: true, force: true });
  }
}

async function verifyRuntimeModels(ModelRuntime) {
  const authDir = mkdtempSync(path.join(tmpdir(), "pi-gui-packaged-runtime-models-"));
  let runtime;
  try {
    runtime = await ModelRuntime.create({
      authPath: path.join(authDir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const models = runtime.getModels();
    for (const check of modelChecks) {
      const model = models.find(
        (entry) => entry.provider === check.provider && entry.id === check.id,
      );
      const modelKey = `${check.provider}/${check.id}`;
      if (!model) {
        throw new Error(`Packaged Pi runtime does not expose ${modelKey} for ${check.reason}.`);
      }
      if (check.requireReasoning && !model.reasoning) {
        throw new Error(`Packaged ${modelKey} is missing reasoning support for ${check.reason}.`);
      }
      if (check.requireImageInput && !model.input.includes("image")) {
        throw new Error(`Packaged ${modelKey} is missing image input support for ${check.reason}.`);
      }
      if (check.requireMaxThinking && model.thinkingLevelMap?.max !== "max") {
        throw new Error(
          `Packaged ${modelKey} is missing max thinking support for ${check.reason}.`,
        );
      }
    }
  } finally {
    await runtime?.dispose?.();
    rmSync(authDir, { recursive: true, force: true });
  }
}

async function verifyPackagedRuntimeImports(extractedDir) {
  for (const modulePath of packagedRuntimeImportChecks) {
    const runtimeEntry = path.join(extractedDir, "node_modules", ...modulePath);
    await import(pathToFileURL(runtimeEntry).href);
  }
}

async function verifyNativeNodePty(asarPath) {
  const unpackedResourcesDir = `${asarPath}.unpacked`;
  const nodePtyDir = path.join(unpackedResourcesDir, "node_modules", "node-pty");
  if (!existsSync(nodePtyDir) || !hasFileWithExtension(nodePtyDir, ".node")) {
    throw new Error(`Packaged app is missing unpacked node-pty native module under ${nodePtyDir}`);
  }
  if (packagePlatform !== "darwin") {
    return;
  }
  const helperPath = findFileNamed(nodePtyDir, "spawn-helper");
  if (!helperPath) {
    throw new Error(`Packaged app is missing unpacked node-pty spawn-helper under ${nodePtyDir}`);
  }
  await access(helperPath, constants.X_OK);
}

function hasFileWithExtension(directoryPath, extension) {
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isFile() && entry.name.endsWith(extension)) {
      return true;
    }
    if (entry.isDirectory() && hasFileWithExtension(entryPath, extension)) {
      return true;
    }
  }
  return false;
}

function findFileNamed(directoryPath, fileName) {
  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isFile() && entry.name === fileName) {
      return entryPath;
    }
    if (entry.isDirectory()) {
      const nestedMatch = findFileNamed(entryPath, fileName);
      if (nestedMatch) {
        return nestedMatch;
      }
    }
  }
  return undefined;
}
