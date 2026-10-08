import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

import {
  createNamedThread,
  getDesktopState,
  launchPackagedDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForSelectedSessionReady,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

const sdkCatalog = readFileSync(resolve(process.cwd(), "pnpm-workspace.yaml"), "utf8");
const expectedSdkVersion = /^\s+"@earendil-works\/pi-coding-agent":\s+(\S+)\s*$/m.exec(
  sdkCatalog,
)?.[1];
if (!expectedSdkVersion)
  throw new Error("The pi-sdk catalog is missing the Pi Coding Agent version.");

test("packaged app seeds and reuses the external Pi SDK runtime across a disposable session restart", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir("pi-gui-sdk-runtime-user-data-");
  const workspacePath = await makeWorkspace("pi-gui-sdk-runtime-workspace");
  const runtimeRoot = join(userDataDir, "pi-sdk");
  let sessionId: string;

  let harness = await launchPackagedDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    scrubProviderEnv: true,
  });
  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "External SDK packaged acceptance");
    const state = await getDesktopState(window);
    sessionId = state.selectedSessionId;
    expect(sessionId).toBeTruthy();

    const pointer = JSON.parse(await readFile(join(runtimeRoot, "current.json"), "utf8")) as {
      readonly directory: string;
    };
    expect(pointer.directory).toBe(expectedSdkVersion);
    const manifest = JSON.parse(
      await readFile(join(runtimeRoot, pointer.directory, "manifest.json"), "utf8"),
    ) as { readonly sdkVersion: string; readonly appMajorVersion: number };
    expect(manifest).toMatchObject({ sdkVersion: expectedSdkVersion, appMajorVersion: 1 });
    const codingAgent = JSON.parse(
      await readFile(
        join(
          runtimeRoot,
          pointer.directory,
          "node_modules",
          "@earendil-works",
          "pi-coding-agent",
          "package.json",
        ),
        "utf8",
      ),
    ) as { readonly version: string };
    expect(codingAgent.version).toBe(manifest.sdkVersion);
    expect(
      await readFile(join(runtimeRoot, "activation.json"), "utf8").catch(() => undefined),
    ).toBeUndefined();
    expect(
      await readFile(join(runtimeRoot, "previous.json"), "utf8").catch(() => undefined),
    ).toBeUndefined();
    expect(workspace.id).toBe(state.selectedWorkspaceId);
  } finally {
    await harness.close();
  }

  const brokenTrialDirectory = join(runtimeRoot, "2.0.0");
  await mkdir(brokenTrialDirectory, { recursive: true });
  await writeFile(
    join(brokenTrialDirectory, "manifest.json"),
    JSON.stringify({ runtimeApiVersion: 999 }),
  );
  await writeFile(join(runtimeRoot, "current.json"), JSON.stringify({ directory: "2.0.0" }));
  await writeFile(
    join(runtimeRoot, "activation.json"),
    JSON.stringify({ previousDirectory: expectedSdkVersion, nextDirectory: "2.0.0" }),
  );

  harness = await launchPackagedDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
    scrubProviderEnv: true,
  });
  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    await waitForSelectedSessionReady(window, { sessionId: sessionId!, workspaceId: workspace.id });
    const state = await getDesktopState(window);
    expect(state.selectedSessionId).toBe(sessionId);
    const pointer = JSON.parse(await readFile(join(runtimeRoot, "current.json"), "utf8")) as {
      readonly directory: string;
    };
    expect(pointer.directory).toBe(expectedSdkVersion);
    expect(
      await readFile(join(runtimeRoot, "activation.json"), "utf8").catch(() => undefined),
    ).toBeUndefined();
  } finally {
    await harness.close();
  }
});
