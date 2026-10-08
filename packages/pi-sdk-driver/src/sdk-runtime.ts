import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PI_SDK_RUNTIME_API_VERSION = 1;

export interface PiSdkRuntimeManifest {
  readonly runtimeApiVersion: number;
  readonly sdkVersion: string;
  readonly appMajorVersion: number;
  readonly packages: Readonly<Record<string, string>>;
  readonly integrity?: string;
}

const SDK_FAMILY = [
  "@earendil-works/chord",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-codemode",
  "@earendil-works/pi-mcp",
  "@earendil-works/pi-telemetry",
  "@earendil-works/pi-tui",
] as const;
const CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
const CHORD_PACKAGE = "@earendil-works/chord";

export interface PiSdkRuntime {
  readonly codingAgent: typeof import("@earendil-works/pi-coding-agent");
  readonly chord: typeof import("@earendil-works/chord");
  readonly manifest: PiSdkRuntimeManifest;
  readonly directory: string | undefined;
}

let configuredDirectory: string | undefined;
let externalRuntimeRequired = false;
let runtimePromise: Promise<PiSdkRuntime> | undefined;

export function configurePiSdkRuntime(options: {
  readonly directory?: string;
  readonly required?: boolean;
}): void {
  if (runtimePromise) {
    throw new Error("Pi SDK runtime has already been loaded");
  }
  configuredDirectory = options.directory ? resolve(options.directory) : undefined;
  externalRuntimeRequired = options.required ?? false;
}

export async function loadPiSdkRuntime(): Promise<PiSdkRuntime> {
  runtimePromise ??= loadRuntime();
  return runtimePromise;
}

async function loadRuntime(): Promise<PiSdkRuntime> {
  if (!configuredDirectory) {
    if (externalRuntimeRequired) {
      throw new Error("The managed Pi SDK runtime is required but was not configured");
    }
    const [codingAgent, chord] = await Promise.all([
      import(CODING_AGENT_PACKAGE),
      import(CHORD_PACKAGE),
    ]);
    return {
      codingAgent,
      chord,
      manifest: {
        runtimeApiVersion: PI_SDK_RUNTIME_API_VERSION,
        sdkVersion: "development",
        appMajorVersion: 0,
        packages: {},
      },
      directory: undefined,
    };
  }

  const runtimeDirectory = await resolveCurrentRuntimeDirectory(configuredDirectory);
  const { manifest, codingAgent, chord } = await verifyPiSdkRuntimeDirectory(runtimeDirectory);
  return { codingAgent, chord, manifest, directory: runtimeDirectory };
}

export async function verifyPiSdkRuntimeDirectory(
  directory: string,
  expectedSdkVersion?: string,
): Promise<{
  readonly manifest: PiSdkRuntimeManifest;
  readonly codingAgent: typeof import("@earendil-works/pi-coding-agent");
  readonly chord: typeof import("@earendil-works/chord");
}> {
  const manifest = await readManifest(directory);
  if (expectedSdkVersion && manifest.sdkVersion !== expectedSdkVersion) {
    throw new Error(
      "Managed Pi SDK " +
        manifest.sdkVersion +
        " does not match expected catalog version " +
        expectedSdkVersion,
    );
  }
  if (manifest.runtimeApiVersion !== PI_SDK_RUNTIME_API_VERSION) {
    throw new Error(
      `Pi SDK runtime API ${manifest.runtimeApiVersion} is incompatible with app API ${PI_SDK_RUNTIME_API_VERSION}`,
    );
  }
  await verifySdkFamily(directory, manifest);
  const [codingAgent, chord] = await Promise.all([
    importPackage(directory, CODING_AGENT_PACKAGE),
    importPackage(directory, CHORD_PACKAGE),
  ]);
  if (
    typeof codingAgent.SessionManager !== "function" ||
    typeof codingAgent.ModelRuntime?.create !== "function" ||
    typeof codingAgent.CURRENT_SESSION_VERSION !== "number" ||
    typeof chord.createFacetHost !== "function"
  ) {
    throw new Error("Managed Pi SDK runtime does not provide the APIs required by this app");
  }
  return { manifest, codingAgent, chord };
}

async function verifySdkFamily(directory: string, manifest: PiSdkRuntimeManifest): Promise<void> {
  for (const name of SDK_FAMILY) {
    if (manifest.packages[name] !== manifest.sdkVersion) {
      throw new Error(`Managed Pi SDK manifest has an inconsistent ${name} version`);
    }
    const packageJsonPath = join(directory, "node_modules", ...name.split("/"), "package.json");
    const metadata: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"));
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      !("version" in metadata) ||
      metadata.version !== manifest.sdkVersion
    ) {
      throw new Error(`Managed Pi SDK package ${name} does not match ${manifest.sdkVersion}`);
    }
  }
}

async function resolveCurrentRuntimeDirectory(root: string): Promise<string> {
  const pointer: unknown = JSON.parse(await readFile(join(root, "current.json"), "utf8"));
  if (
    typeof pointer !== "object" ||
    pointer === null ||
    !("directory" in pointer) ||
    typeof pointer.directory !== "string" ||
    !pointer.directory.trim() ||
    isAbsolute(pointer.directory)
  ) {
    throw new Error("Managed Pi SDK current pointer is invalid");
  }
  const runtimeDirectory = resolve(root, pointer.directory);
  if (dirname(runtimeDirectory) !== root) {
    throw new Error("Managed Pi SDK current pointer must name a version directory");
  }
  return runtimeDirectory;
}

async function readManifest(directory: string): Promise<PiSdkRuntimeManifest> {
  const parsed: unknown = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("runtimeApiVersion" in parsed) ||
    !("sdkVersion" in parsed) ||
    !("appMajorVersion" in parsed) ||
    !("packages" in parsed) ||
    typeof parsed.runtimeApiVersion !== "number" ||
    typeof parsed.sdkVersion !== "string" ||
    typeof parsed.appMajorVersion !== "number" ||
    typeof parsed.packages !== "object" ||
    parsed.packages === null
  ) {
    throw new Error("Managed Pi SDK runtime manifest is invalid");
  }
  return parsed as PiSdkRuntimeManifest;
}

async function importPackage(directory: string, name: string): Promise<any> {
  const packageDirectory = join(directory, "node_modules", ...name.split("/"));
  const packageJsonPath = join(packageDirectory, "package.json");
  const packageJson: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (typeof packageJson !== "object" || packageJson === null) {
    throw new Error(`Managed package metadata is invalid: ${name}`);
  }
  const metadata = packageJson as {
    exports?: Record<string, unknown>;
    main?: string;
  };
  const rootExport = metadata.exports?.["."];
  const entry =
    typeof rootExport === "string"
      ? rootExport
      : typeof rootExport === "object" && rootExport !== null && "import" in rootExport
        ? (rootExport as { import: string }).import
        : metadata.main;
  if (!entry || typeof entry !== "string") {
    throw new Error(`Managed package has no import entry: ${name}`);
  }
  return import(pathToFileURL(join(packageDirectory, entry)).href);
}
