import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { c as createTar, x as extractTar } from "tar";
import {
  PI_SDK_RUNTIME_API_VERSION,
  verifyPiSdkRuntimeDirectory,
  type PiSdkRuntimeManifest,
} from "./sdk-runtime.js";

const DEFAULT_RELEASES_URL =
  "https://api.github.com/repos/minghinmatthewlam/pi-gui/releases/latest";
const INITIAL_UPDATE_DELAY_MS = 15_000;
const UPDATE_INTERVAL_MS = 4 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 120_000;
const MAX_RUNTIME_ARCHIVE_BYTES = 512 * 1024 * 1024;

export interface PiSdkRuntimeManagerOptions {
  readonly runtimeRoot: string;
  readonly appVersion: string;
  readonly bootstrapArchivePath: string;
  readonly bootstrapDigestPath: string;
  readonly releasesUrl?: string;
  readonly fetcher?: typeof fetch;
}

export type PiSdkRuntimeUpdateResult =
  | { readonly status: "no-update"; readonly currentVersion: string }
  | { readonly status: "staged"; readonly currentVersion: string; readonly version: string }
  | { readonly status: "failed"; readonly message: string };

interface VersionPointer {
  readonly directory: string;
}

interface ActivationJournal {
  readonly previousDirectory: string;
  readonly nextDirectory: string;
}

interface GitHubRelease {
  readonly draft?: boolean;
  readonly prerelease?: boolean;
  readonly assets?: readonly {
    readonly name?: string;
    readonly browser_download_url?: string;
    readonly digest?: string;
  }[];
}
type GitHubReleaseAsset = NonNullable<GitHubRelease["assets"]>[number];

export async function preparePiSdkRuntime(
  options: PiSdkRuntimeManagerOptions,
): Promise<{ readonly directory: string; readonly version: string }> {
  const runtimeRoot = resolve(options.runtimeRoot);
  await mkdir(runtimeRoot, { recursive: true });
  await recoverInterruptedActivation(runtimeRoot);

  let current = await readPointer(runtimeRoot, "current.json");
  if (!current) {
    const version = await installBootstrapRuntime(runtimeRoot, options);
    current = { directory: version };
  }

  const pending = await readPointer(runtimeRoot, "pending.json");
  if (pending && pending.directory !== current.directory) {
    try {
      await assertRuntimeDirectory(runtimeRoot, pending.directory);
      const candidate = await verifyPiSdkRuntimeDirectory(join(runtimeRoot, pending.directory));
      assertAppCompatibility(candidate.manifest, options.appVersion);
      await writeJsonAtomic(join(runtimeRoot, "activation.json"), {
        previousDirectory: current.directory,
        nextDirectory: pending.directory,
      } satisfies ActivationJournal);
      await writeJsonAtomic(join(runtimeRoot, "current.json"), pending);
      await rm(join(runtimeRoot, "pending.json"), { force: true });
      current = pending;
    } catch (error) {
      console.warn("[pi-sdk-runtime] discarded an invalid staged update:", error);
      await rm(join(runtimeRoot, "pending.json"), { force: true });
    }
  }

  const version = versionFromDirectory(current.directory);
  const installed = await verifyPiSdkRuntimeDirectory(join(runtimeRoot, current.directory));
  assertAppCompatibility(installed.manifest, options.appVersion);
  return { directory: runtimeRoot, version };
}

export async function markPiSdkRuntimeHealthy(runtimeRoot: string, version: string): Promise<void> {
  const root = resolve(runtimeRoot);
  const active = await readPointer(root, "current.json");
  if (!active || versionFromDirectory(active.directory) !== version) {
    throw new Error("Cannot confirm a Pi SDK runtime that is not active");
  }
  const journal = await readJson<ActivationJournal>(join(root, "activation.json"));
  if (journal?.nextDirectory === active.directory) {
    await writeJsonAtomic(join(root, "previous.json"), {
      directory: journal.previousDirectory,
    } satisfies VersionPointer);
    await rm(join(root, "activation.json"), { force: true });
  }
}

export async function checkAndStagePiSdkRuntimeUpdate(
  options: PiSdkRuntimeManagerOptions,
): Promise<PiSdkRuntimeUpdateResult> {
  const root = resolve(options.runtimeRoot);
  const current = await readPointer(root, "current.json");
  if (!current) return { status: "failed", message: "No active Pi SDK runtime is installed." };
  const currentVersion = versionFromDirectory(current.directory);
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const releaseResponse = await fetcher(options.releasesUrl ?? DEFAULT_RELEASES_URL, {
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      signal: controller.signal,
    });
    if (!releaseResponse.ok) {
      throw new Error(`Stable release lookup returned HTTP ${releaseResponse.status}.`);
    }
    const release = (await releaseResponse.json()) as GitHubRelease;
    if (release.draft || release.prerelease || !Array.isArray(release.assets)) {
      throw new Error("Stable release metadata is invalid.");
    }
    const candidates = release.assets
      .map((asset) => ({ asset, version: versionFromAssetName(asset.name) }))
      .filter((entry): entry is { asset: GitHubReleaseAsset; version: string } =>
        Boolean(entry.version),
      )
      .sort((a, b) => compareVersions(b.version, a.version));
    const candidate = candidates[0];
    if (!candidate || compareVersions(candidate.version, currentVersion) <= 0) {
      return { status: "no-update", currentVersion };
    }

    const downloadUrl = candidate.asset.browser_download_url;
    if (!isGitHubDownloadUrl(downloadUrl)) {
      throw new Error("Pi SDK runtime release has an invalid download URL.");
    }
    const digest = parseSha256(candidate.asset.digest);
    if (!digest) {
      throw new Error("Pi SDK runtime release is missing its verified SHA-256 digest.");
    }
    const archiveResponse = await fetcher(downloadUrl, { signal: controller.signal });
    if (!archiveResponse.ok) {
      throw new Error(`Pi SDK runtime download returned HTTP ${archiveResponse.status}.`);
    }
    const declaredSize = Number(archiveResponse.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_RUNTIME_ARCHIVE_BYTES) {
      throw new Error("Pi SDK runtime archive exceeds the 512 MiB safety limit.");
    }
    const archive = Buffer.from(await archiveResponse.arrayBuffer());
    if (archive.byteLength > MAX_RUNTIME_ARCHIVE_BYTES) {
      throw new Error("Pi SDK runtime archive exceeds the 512 MiB safety limit.");
    }
    if (createHash("sha256").update(archive).digest("hex") !== digest) {
      throw new Error("Pi SDK runtime archive SHA-256 verification failed.");
    }

    const stagedDirectory = await extractAndVerifyArchive(
      root,
      archive,
      candidate.version,
      options.appVersion,
    );
    await writeJsonAtomic(join(root, "pending.json"), {
      directory: basename(stagedDirectory),
    } satisfies VersionPointer);
    return { status: "staged", currentVersion, version: candidate.version };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pi SDK runtime update failed.";
    return { status: "failed", message };
  } finally {
    clearTimeout(timeout);
  }
}

export function startPiSdkRuntimeUpdater(
  options: PiSdkRuntimeManagerOptions,
  report: (result: PiSdkRuntimeUpdateResult) => void = (result) => {
    if (result.status === "failed")
      console.warn("[pi-sdk-runtime] update check failed:", result.message);
  },
): () => void {
  let stopped = false;
  const check = async () => {
    if (stopped) return;
    try {
      const result = await checkAndStagePiSdkRuntimeUpdate(options);
      if (!stopped) report(result);
    } catch (error) {
      if (!stopped) {
        report({
          status: "failed",
          message: error instanceof Error ? error.message : "Pi SDK runtime update failed.",
        });
      }
    }
  };
  const initial = setTimeout(() => void check(), INITIAL_UPDATE_DELAY_MS);
  const interval = setInterval(() => void check(), UPDATE_INTERVAL_MS);
  return () => {
    stopped = true;
    clearTimeout(initial);
    clearInterval(interval);
  };
}

export async function createPiSdkRuntimeArchive(
  runtimeDirectory: string,
  archivePath: string,
): Promise<string> {
  // pnpm deploy may hard-link package files from its store. Materializing a
  // private copy avoids producing tar hard-link entries whose target can appear
  // later in the archive, which Windows extraction rejects.
  const archiveSource = join(tmpdir(), `pi-sdk-runtime-archive-${randomUUID()}`);
  try {
    await cp(runtimeDirectory, archiveSource, { recursive: true, dereference: true });
    await createTar(
      {
        cwd: archiveSource,
        file: archivePath,
        gzip: true,
        portable: true,
        mtime: new Date(0),
      },
      ["manifest.json", "package.json", "node_modules"],
    );
    return createHash("sha256")
      .update(await readFile(archivePath))
      .digest("hex");
  } finally {
    await rm(archiveSource, { recursive: true, force: true });
  }
}

async function installBootstrapRuntime(
  runtimeRoot: string,
  options: PiSdkRuntimeManagerOptions,
): Promise<string> {
  const archive = await readFile(options.bootstrapArchivePath);
  const expectedDigest = parseSha256((await readFile(options.bootstrapDigestPath, "utf8")).trim());
  if (!expectedDigest || createHash("sha256").update(archive).digest("hex") !== expectedDigest) {
    throw new Error("Packaged Pi SDK runtime seed failed SHA-256 verification.");
  }
  const staged = await extractAndVerifyArchive(runtimeRoot, archive, undefined, options.appVersion);
  const version = basename(staged);
  await writeJsonAtomic(join(runtimeRoot, "current.json"), {
    directory: version,
  } satisfies VersionPointer);
  return version;
}

async function extractAndVerifyArchive(
  runtimeRoot: string,
  archive: Buffer,
  expectedVersion: string | undefined,
  appVersion: string,
): Promise<string> {
  const stage = join(runtimeRoot, `.staging-${randomUUID()}`);
  const archivePath = join(runtimeRoot, `.download-${randomUUID()}.tgz`);
  await mkdir(stage, { recursive: true });
  try {
    await writeFile(archivePath, archive, { flag: "wx" });
    await extractTar({ cwd: stage, file: archivePath, strict: true, preservePaths: false });
    const { manifest } = await verifyPiSdkRuntimeDirectory(stage);
    assertAppCompatibility(manifest, appVersion);
    if (expectedVersion && manifest.sdkVersion !== expectedVersion) {
      throw new Error("Downloaded runtime version does not match its release asset name.");
    }
    const versionDirectory = join(runtimeRoot, manifest.sdkVersion);
    await assertRuntimeDirectory(runtimeRoot, manifest.sdkVersion);
    try {
      await rename(stage, versionDirectory);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await verifyPiSdkRuntimeDirectory(versionDirectory);
      if (existing.manifest.sdkVersion !== manifest.sdkVersion) throw error;
    }
    return versionDirectory;
  } finally {
    await rm(archivePath, { force: true }).catch(() => undefined);
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function recoverInterruptedActivation(runtimeRoot: string): Promise<void> {
  const journal = await readJson<ActivationJournal>(join(runtimeRoot, "activation.json"));
  if (!journal) return;
  await assertRuntimeDirectory(runtimeRoot, journal.previousDirectory);
  await writeJsonAtomic(join(runtimeRoot, "current.json"), {
    directory: journal.previousDirectory,
  } satisfies VersionPointer);
  await rm(join(runtimeRoot, "activation.json"), { force: true });
  // A failed trial should not be retried on every launch. Keep the verified
  // previous runtime active and discard only the pending pointer.
  await rm(join(runtimeRoot, "pending.json"), { force: true });
}

async function assertRuntimeDirectory(runtimeRoot: string, directory: string): Promise<void> {
  if (!directory || basename(directory) !== directory || directory.startsWith(".")) {
    throw new Error("Pi SDK runtime pointer must name a direct version directory.");
  }
  const expectedParent = resolve(runtimeRoot);
  const relativeDirectory = relative(expectedParent, resolve(runtimeRoot, directory));
  if (
    !relativeDirectory ||
    relativeDirectory.startsWith(`..${sep}`) ||
    relativeDirectory === ".."
  ) {
    throw new Error("Pi SDK runtime pointer escapes its managed directory.");
  }
}

async function readPointer(root: string, fileName: string): Promise<VersionPointer | undefined> {
  const parsed = await readJson<VersionPointer>(join(root, fileName));
  if (!parsed) return undefined;
  await assertRuntimeDirectory(root, parsed.directory);
  return parsed;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporaryPath, path);
}

function versionFromDirectory(directory: string): string {
  const version = basename(directory);
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("Pi SDK runtime pointer contains an invalid version.");
  }
  return version;
}

function versionFromAssetName(name: string | undefined): string | undefined {
  const match = /^pi-sdk-runtime-(\d+\.\d+\.\d+)\.tgz$/.exec(name ?? "");
  return match?.[1];
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

function assertAppCompatibility(manifest: PiSdkRuntimeManifest, appVersion: string): void {
  const appMajor = Number(/^\d+/.exec(appVersion)?.[0]);
  if (!Number.isInteger(manifest.appMajorVersion) || appMajor !== manifest.appMajorVersion) {
    throw new Error(
      `Pi SDK runtime supports app major ${manifest.appMajorVersion}; this app is ${appVersion}.`,
    );
  }
}

function isGitHubDownloadUrl(value: string | undefined): value is string {
  try {
    const url = new URL(value ?? "");
    return (
      url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

function parseSha256(value: string | undefined): string | undefined {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(value ?? "");
  return match?.[1]?.toLowerCase();
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EEXIST" || error.code === "ENOTEMPTY")
  );
}
