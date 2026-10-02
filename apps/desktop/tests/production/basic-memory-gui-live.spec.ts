import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  getDesktopState,
  launchPackagedDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";

test("installed Pi GUI retrieves Matthew Way Studio through Basic Memory MCP", async () => {
  test.skip(
    process.env.PI_APP_RUN_BASIC_MEMORY_LIVE !== "1",
    "Set PI_APP_RUN_BASIC_MEMORY_LIVE=1 to make the authenticated subscription request.",
  );
  test.setTimeout(240_000);

  const sourceAgentDir = join(homedir(), ".pi", "agent");
  const userDataDir = await makeUserDataDir("pi-gui-basic-memory-live-");
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("basic-memory-gui-live");
  await mkdir(agentDir, { recursive: true });

  for (const name of [
    "auth.json",
    "settings.json",
    "models.json",
    "mcp-adapter.json",
    "mcp-cache.json",
  ]) {
    await copyFile(join(sourceAgentDir, name), join(agentDir, name));
  }

  const settingsPath = join(agentDir, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  await writeFile(
    settingsPath,
    `${JSON.stringify(
      {
        ...settings,
        defaultProvider: "qwen-token-plan",
        defaultModel: "qwen3.8-max",
        defaultThinkingLevel: "medium",
        enabledModels: ["qwen-token-plan/qwen3.8-max"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const harness = await launchPackagedDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await window
      .getByRole("complementary")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await window
      .getByTestId("new-thread-composer")
      .fill(
        'Use the MCP adapter to search the "basic-memory" server for the note titled "Matthew Way Studio - Pi GUI Autonomous Multi-Agent Workbench". Retrieve that note and report one specific recorded decision in at most two sentences, naming the note. Do not answer from prior knowledge or use other tools. If retrieval fails, state that plainly.',
      );
    await window.getByRole("button", { name: "Start thread" }).click();

    await expect(window.locator(".model-selector__badge").first()).toHaveText(
      "qwen-token-plan:qwen3.8-max",
    );
    const assistant = window.locator(".timeline-item--assistant .message__content").last();
    await expect(assistant).toContainText("Matthew Way Studio", { timeout: 180_000 });
    const toolItems = window.locator(".timeline-tool");
    await expect
      .poll(async () => {
        const labels = await toolItems.allTextContents();
        return labels.some((label) => /mcp|basic[-_]memory/i.test(label) && /done/i.test(label));
      })
      .toBe(true);

    const state = await getDesktopState(window);
    const selectedWorkspace = state.workspaces.find(({ id }) => id === state.selectedWorkspaceId);
    expect(
      selectedWorkspace?.sessions.find(({ id }) => id === state.selectedSessionId),
    ).toBeTruthy();
  } finally {
    await harness.close();
  }
});
