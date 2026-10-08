#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, sep, join, resolve } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const expected = {
  rabbit: {
    commit: "5c77738a2b9cd25bf086127bb453a35e4a420421",
    packageDirectory: "packages/rabbit",
  },
  compact: {
    commit: "b3702b1b9ccdb6b5ca3405d73ef23e06618d1ef4",
    packageDirectory: "packages/codex-compact",
  },
};

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(usage());
    result[key.slice(2)] = value;
  }
  for (const key of ["rabbit-repo", "extensions-repo", "output"]) {
    if (!result[key]) throw new Error(usage());
  }
  return {
    rabbitRepo: resolve(result["rabbit-repo"]),
    extensionsRepo: resolve(result["extensions-repo"]),
    outputRoot: resolve(result.output),
  };
}

function usage() {
  return "Usage: node scripts/gary-pi-context/prepare-local-integration.mjs --rabbit-repo PATH --extensions-repo PATH --output NEW_DIRECTORY";
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function run(executable, args, cwd, options = {}) {
  const isWindows = process.platform === "win32";
  const command = isWindows ? (process.env.ComSpec ?? "cmd.exe") : executable;
  const commandArgs = isWindows
    ? ["/d", "/s", "/c", [executable, ...args].map(quoteCmdArgument).join(" ")]
    : args;
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${executable} ${args.join(" ")} failed in ${cwd} (exit ${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

function quoteCmdArgument(value) {
  const text = String(value);
  return /[\s"&|<>^]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function git(repository, ...args) {
  return run("git", args, repository);
}

function assertCleanHead(repository, expectedCommit, label) {
  const head = git(repository, "rev-parse", "HEAD");
  if (head !== expectedCommit) {
    throw new Error(`${label} checkout is ${head}; expected ${expectedCommit}`);
  }
  const status = git(repository, "status", "--porcelain", "--untracked-files=no");
  if (status) throw new Error(`${label} has tracked changes; refusing to package them:\n${status}`);
  return head;
}

function isInside(path, parent) {
  const relation = relative(resolve(parent).toLowerCase(), resolve(path).toLowerCase());
  return relation === "" || (!isAbsolute(relation) && !relation.startsWith(`..${sep}`) && relation !== "..");
}

async function assertSafeOutput(outputRoot) {
  const protectedPaths = [
    join(homedir(), ".pi", "agent"),
    join(process.env.APPDATA ?? homedir(), "Pi Studio"),
    join(process.env.LOCALAPPDATA ?? homedir(), "Programs", "Pi Studio"),
  ];
  if (protectedPaths.some((protectedPath) => isInside(outputRoot, protectedPath))) {
    throw new Error("Output points into a live Pi profile or application directory.");
  }
  try {
    const contents = await readdir(outputRoot);
    if (contents.length > 0) throw new Error(`Output must be a new or empty directory: ${outputRoot}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function npmPack(cwd, artifactDirectory) {
  const args = ["pack", "--json", "--ignore-scripts", "--pack-destination", artifactDirectory];
  const output = run("npm", args, cwd);
  const records = JSON.parse(output);
  if (!Array.isArray(records) || records.length !== 1 || !records[0].filename) {
    throw new Error(`Unexpected npm pack output from ${cwd}`);
  }
  return records[0];
}

async function installDependencies(packageDirectory) {
  run("npm", ["install", "--ignore-scripts", "--omit=dev", "--package-lock=true"], packageDirectory);
  const lockBytes = run("npm", ["ls", "--omit=dev", "--json"], packageDirectory);
  const lock = JSON.parse(lockBytes);
  const dependencies = Object.fromEntries(
    Object.entries(lock.dependencies ?? {}).map(([name, value]) => [name, value.version]),
  );
  return {
    dependencies,
    lockSha256: sha256(await readFile(join(packageDirectory, "package-lock.json"))),
  };
}

async function readFileBuffer(path) {
  return readFile(path);
}

async function extractPackage(tarball, artifactDirectory, destination) {
  await mkdir(destination, { recursive: true });
  run("tar", ["-xzf", tarball, "-C", destination], artifactDirectory);
  const extractedPackage = join(destination, "package");
  await stat(join(extractedPackage, "package.json"));
  return extractedPackage;
}

async function main() {
  const { rabbitRepo, extensionsRepo, outputRoot } = parseArgs(process.argv.slice(2));
  await assertSafeOutput(outputRoot);
  assertCleanHead(rabbitRepo, expected.rabbit.commit, "Rabbit");
  assertCleanHead(extensionsRepo, expected.compact.commit, "Pi extensions");

  const artifactDirectory = join(outputRoot, "artifacts");
  const packageDirectory = join(outputRoot, "packages");
  const extractionDirectory = join(outputRoot, "extracted");
  const agentDirectory = join(outputRoot, "agent");
  const sessionDirectory = join(agentDirectory, "sessions");
  const missionDirectory = join(outputRoot, "mission");
  await Promise.all([
    mkdir(artifactDirectory, { recursive: true }),
    mkdir(packageDirectory, { recursive: true }),
    mkdir(extractionDirectory, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
    mkdir(missionDirectory, { recursive: true }),
  ]);

  run("corepack", ["pnpm", "run", "build"], rabbitRepo);
  run("npm", ["run", "build"], join(extensionsRepo, "packages", "pi-codex-compact"));

  const rabbitPack = npmPack(rabbitRepo, artifactDirectory);
  const compactPack = npmPack(join(extensionsRepo, "packages", "pi-codex-compact"), artifactDirectory);
  const rabbitTarball = join(artifactDirectory, rabbitPack.filename);
  const compactTarball = join(artifactDirectory, compactPack.filename);

  const rabbitUnpacked = await extractPackage(
    rabbitTarball,
    artifactDirectory,
    join(extractionDirectory, "rabbit"),
  );
  const compactUnpacked = await extractPackage(
    compactTarball,
    artifactDirectory,
    join(extractionDirectory, "codex-compact"),
  );
  const rabbitDestination = join(outputRoot, expected.rabbit.packageDirectory);
  const compactDestination = join(outputRoot, expected.compact.packageDirectory);
  await cp(rabbitUnpacked, rabbitDestination, { recursive: true });
  await cp(compactUnpacked, compactDestination, { recursive: true });

  const [rabbitDependencies, compactDependencies] = await Promise.all([
    installDependencies(rabbitDestination),
    installDependencies(compactDestination),
  ]);
  const agentSettings = {
    packages: [rabbitDestination, compactDestination],
  };
  const settingsPath = join(agentDirectory, "settings.json");
  await writeFile(settingsPath, `${JSON.stringify(agentSettings, null, 2)}\n`, "utf8");

  const manifest = {
    schema: 1,
    sources: {
      rabbit: { repository: rabbitRepo, commit: expected.rabbit.commit },
      compact: { repository: extensionsRepo, commit: expected.compact.commit },
    },
    artifacts: {
      rabbit: {
        file: rabbitPack.filename,
        package: rabbitPack.name,
        version: rabbitPack.version,
        sha256: sha256(await readFileBuffer(rabbitTarball)),
        integrity: rabbitPack.integrity,
        packagePath: rabbitDestination,
        packageLockSha256: rabbitDependencies.lockSha256,
        dependencies: rabbitDependencies.dependencies,
      },
      compact: {
        file: compactPack.filename,
        package: compactPack.name,
        version: compactPack.version,
        sha256: sha256(await readFileBuffer(compactTarball)),
        integrity: compactPack.integrity,
        packagePath: compactDestination,
        packageLockSha256: compactDependencies.lockSha256,
        dependencies: compactDependencies.dependencies,
        publishedVersionCollision: true,
      },
    },
    settings: {
      path: settingsPath,
      sha256: sha256(await readFileBuffer(settingsPath)),
      packages: agentSettings.packages,
    },
    profile: {
      agentDirectory,
      sessionDirectory,
      missionDirectory,
      credentialsCopied: false,
    },
  };
  await writeFile(join(outputRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ outputRoot, manifest: join(outputRoot, "manifest.json") }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
