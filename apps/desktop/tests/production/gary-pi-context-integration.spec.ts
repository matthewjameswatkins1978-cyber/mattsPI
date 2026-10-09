import { createHash, randomUUID } from "node:crypto";
import { copyFile, cp, mkdir, readFile, readdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  getDesktopState,
  getSelectedTranscript,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForSelectedSessionReady,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

const rabbitStateType = "rabbit-pi-compactor-state-v1";
const expectedRabbitCommit = "36945af03ec3e2f9e7dc122091d215d829dc9226";
const expectedCompactCommit = "b3702b1b9ccdb6b5ca3405d73ef23e06618d1ef4";

interface RabbitState {
  readonly mode: "auto" | "manual" | "off" | "garden";
  readonly config: { readonly thresholdOverride: number | null };
}

interface LocalIntegrationManifest {
  readonly sources: {
    readonly rabbit: { readonly commit: string };
    readonly compact: { readonly commit: string };
  };
  readonly artifacts: {
    readonly rabbit: {
      readonly file: string;
      readonly sha256: string;
      readonly packagePath: string;
    };
    readonly compact: {
      readonly file: string;
      readonly sha256: string;
      readonly packagePath: string;
    };
  };
}

test("loads the pinned compaction artifacts and persists Rabbit Settings across restart", async () => {
  const integrationRoot = process.env.GARY_PI_CONTEXT_ROOT;
  test.skip(!integrationRoot, "Set GARY_PI_CONTEXT_ROOT to the prepared isolated package profile.");
  const root = resolve(integrationRoot!);
  const agentDir = join(root, "runs", randomUUID(), "agent");
  await mkdir(agentDir, { recursive: true });
  await copyFile(join(root, "agent", "settings.json"), join(agentDir, "settings.json"));
  for (const name of ["models.json", "models-store.json", "studio-models.json"]) {
    await copyFile(join(root, "agent", name), join(agentDir, name));
  }
  const npmCachePath = join(root, "agent", "npm");
  if (process.platform === "win32") {
    await symlink(npmCachePath, join(agentDir, "npm"), "junction");
  } else {
    await cp(npmCachePath, join(agentDir, "npm"), { recursive: true });
  }
  const artifactDir = join(root, "artifacts");
  const manifest = JSON.parse(
    await readFile(join(root, "manifest.json"), "utf8"),
  ) as LocalIntegrationManifest;

  expect(manifest.sources.rabbit.commit).toBe(expectedRabbitCommit);
  expect(manifest.sources.compact.commit).toBe(expectedCompactCommit);
  await expectArtifactHash(artifactDir, manifest.artifacts.rabbit);
  await expectArtifactHash(artifactDir, manifest.artifacts.compact);

  const userDataDir = await makeUserDataDir("gary-pi-context-user-data-");
  const workspacePath = await makeWorkspace("gary-pi-disposable-mission");
  const sessionDir = join(agentDir, "sessions");
  await mkdir(sessionDir, { recursive: true });
  let harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "foreground",
    agentDir,
    scrubProviderEnv: true,
  });

  let sessionId = "";
  try {
    let window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    const profileRuntime = (await getDesktopState(window)).runtimeByWorkspace[workspace.id];
    expect(profileRuntime?.settings).toMatchObject({
      defaultProvider: "qwen-token-plan",
      defaultModelId: "qwen3.8-flash",
      defaultThinkingLevel: "medium",
    });
    expect(
      profileRuntime?.models.some(
        (model) => model.providerId === "qwen-token-plan" && model.modelId === "qwen3.8-flash",
      ),
    ).toBe(true);
    await expect
      .poll(async () => {
        const runtime = (await getDesktopState(window)).runtimeByWorkspace[workspace.id];
        const paths = (runtime?.extensions ?? []).map((extension) =>
          extension.path.replaceAll("\\", "/"),
        );
        return {
          rabbit: paths.includes(
            resolve(manifest.artifacts.rabbit.packagePath, "src/index.ts").replaceAll("\\", "/"),
          ),
          compact: paths.includes(
            resolve(manifest.artifacts.compact.packagePath, "dist/index.ts").replaceAll("\\", "/"),
          ),
          command: (runtime?.extensions ?? []).some(
            (extension) => extension.enabled && extension.commands.includes("rabbit"),
          ),
        };
      })
      .toEqual({ rabbit: true, compact: true, command: true });

    await createNamedThread(window, "Disposable compaction acceptance");
    let state = await getDesktopState(window);
    sessionId = state.selectedSessionId;
    expect(state.selectedWorkspaceId).toBe(workspace.id);
    await openRabbitSettings(window);
    await expect(window.getByRole("button", { name: "Auto", exact: true })).toBeEnabled();
    await expect(
      window.getByRole("button", { name: "Manual compaction mode", exact: true }),
    ).toBeEnabled();
    await expect(window.getByRole("button", { name: "Off", exact: true })).toBeEnabled();
    await expect(
      window.getByRole("button", { name: "Garden context management mode", exact: true }),
    ).toBeEnabled();

    const percentage = window.getByLabel("Manual trigger percentage");
    await expect(percentage).toHaveAttribute("min", "1");
    await expect(percentage).toHaveAttribute("max", "99");
    await percentage.fill("99");
    await window
      .getByRole("button", { name: "Apply manual trigger 99 percent", exact: true })
      .click();
    await expect(window.getByRole("status")).toContainText("Sent /rabbit threshold 99");
    await expect
      .poll(() => latestRabbitState(sessionDir))
      .toMatchObject({
        mode: "manual",
        config: { thresholdOverride: 99 },
      });

    await window.getByRole("button", { name: "Off", exact: true }).click();
    await expect.poll(() => latestRabbitState(sessionDir)).toMatchObject({ mode: "off" });
    await window
      .getByRole("button", { name: "Garden context management mode", exact: true })
      .click();
    await expect.poll(() => latestRabbitState(sessionDir)).toMatchObject({ mode: "garden" });
    await window.getByRole("button", { name: "Auto", exact: true }).click();
    await expect
      .poll(() => latestRabbitState(sessionDir))
      .toMatchObject({
        mode: "auto",
        config: { thresholdOverride: null },
      });

    await percentage.fill("99");
    await window
      .getByRole("button", { name: "Apply manual trigger 99 percent", exact: true })
      .click();
    await expect
      .poll(() => latestRabbitState(sessionDir))
      .toMatchObject({
        mode: "manual",
        config: { thresholdOverride: 99 },
      });
    await window.getByRole("button", { name: "Show Rabbit status" }).click();
    await expectRabbitStatus(window, "manual");
    await window
      .getByRole("button", { name: "Garden context management mode", exact: true })
      .click();
    await expect.poll(() => latestRabbitState(sessionDir)).toMatchObject({ mode: "garden" });
    await window.getByRole("button", { name: "Show Rabbit status" }).click();
    await expectRabbitStatus(window, "garden");
  } finally {
    await harness.close();
  }

  harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "foreground",
    agentDir,
    scrubProviderEnv: true,
  });
  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    await window.getByRole("button", { name: "Back to app" }).click();
    await waitForSelectedSessionReady(window, { sessionId, workspaceId: workspace.id });
    await openRabbitSettings(window);
    await window.getByRole("button", { name: "Show Rabbit status" }).click();
    await expectRabbitStatus(window, "garden");
    await window.getByRole("button", { name: "Manual compaction mode", exact: true }).click();
    await expect
      .poll(() => latestRabbitState(sessionDir))
      .toMatchObject({
        mode: "manual",
        config: { thresholdOverride: 99 },
      });
    await window.getByRole("button", { name: "Show Rabbit status" }).click();
    await expectRabbitStatus(window, "manual");
  } finally {
    await harness.close();
  }
});

async function expectRabbitStatus(
  window: Page,
  expectedMode: "auto" | "manual" | "off" | "garden",
): Promise<void> {
  const statusLabel = async (): Promise<string | undefined> => {
    const transcript = await getSelectedTranscript(window);
    const messages = transcript?.transcript as unknown as
      readonly { readonly kind: string; readonly label: string }[] | undefined;
    return messages
      ?.filter(
        (message) => message.kind === "activity" && message.label.includes("RABBIT PI COMPACTOR"),
      )
      .at(-1)?.label;
  };
  await expect.poll(statusLabel).toContain(`mode: ${expectedMode}`);
  await expect
    .poll(statusLabel)
    .toMatch(/context: (unknown|\d[\d,]* \/ [\d,]+ effective \([\d.]+%\))/);
  await expect.poll(statusLabel).toContain("window 1,000,000, output reserve 16,384");
}

async function openRabbitSettings(window: Page): Promise<void> {
  await window.keyboard.press(desktopShortcut(","));
  await expect(window.getByTestId("settings-surface")).toBeVisible();
  await window.getByRole("button", { name: "Context & compaction", exact: true }).click();
  await expect(window.getByText("Rabbit Pi Compactor", { exact: true })).toBeVisible();
}

async function expectArtifactHash(
  artifactDir: string,
  artifact: { readonly file: string; readonly sha256: string },
): Promise<void> {
  const digest = createHash("sha256")
    .update(await readFile(join(artifactDir, artifact.file)))
    .digest("hex");
  expect(digest).toBe(artifact.sha256.toLowerCase());
}

async function latestRabbitState(sessionDir: string): Promise<RabbitState | undefined> {
  const states = await readRabbitStates(sessionDir);
  return states.at(-1);
}

async function readRabbitStates(directory: string): Promise<RabbitState[]> {
  const states: RabbitState[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      states.push(...(await readRabbitStates(path)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const lines = (await readFile(path, "utf8")).split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      try {
        const value = JSON.parse(line) as {
          readonly type?: string;
          readonly customType?: string;
          readonly data?: RabbitState;
        };
        if (value.type === "custom" && value.customType === rabbitStateType && value.data) {
          states.push(value.data);
        }
      } catch {
        // Session files may contain non-entry metadata lines; ignore those records.
      }
    }
  }
  return states;
}
