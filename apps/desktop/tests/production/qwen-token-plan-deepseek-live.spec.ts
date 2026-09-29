import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  getDesktopState,
  launchPackagedDesktop,
  makeUserDataDir,
  makeWorkspace,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";
import { sessionFilePathFromCatalog } from "../helpers/session-file";

test("Qwen Token Plan serves its configured DeepSeek Flash route in the installed GUI", async () => {
  test.skip(
    process.env.PI_APP_RUN_DEEPSEEK_QWEN_LIVE !== "1",
    "Set PI_APP_RUN_DEEPSEEK_QWEN_LIVE=1 to make one Qwen Token Plan subscription request.",
  );
  test.setTimeout(240_000);

  const provider = "qwen-token-plan";
  const model = "deepseek-v4-flash-0731";
  const route = `${provider}/${model}`;
  const sourceAgentDir = join(homedir(), ".pi", "agent");
  const userDataDir = await makeUserDataDir("pi-gui-qwen-deepseek-live-");
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("qwen-token-plan-deepseek-live");
  await mkdir(agentDir, { recursive: true });
  for (const name of ["auth.json", "settings.json", "models.json"]) {
    await copyFile(join(sourceAgentDir, name), join(agentDir, name));
  }

  const settingsPath = join(agentDir, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  await writeFile(
    settingsPath,
    `${JSON.stringify(
      {
        ...settings,
        defaultProvider: provider,
        defaultModel: model,
        defaultThinkingLevel: "medium",
        enabledModels: [route],
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
    await waitForWorkspaceByPath(window, workspacePath);
    await window
      .getByRole("complementary")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await window
      .getByTestId("new-thread-composer")
      .fill("Reply with exactly QWEN-SUB-DEEPSEEK-READY.");
    await window.getByRole("button", { name: "Start thread", exact: true }).click();
    const assistant = window.locator(".timeline-item--assistant .message__content").last();
    await expect(assistant).toContainText("QWEN-SUB-DEEPSEEK-READY", { timeout: 180_000 });

    const state = await getDesktopState(window);
    const selectedWorkspace = state.workspaces.find(({ id }) => id === state.selectedWorkspaceId);
    if (!selectedWorkspace || !state.selectedSessionId)
      throw new Error("No selected DeepSeek test session");
    const sessionPath = await sessionFilePathFromCatalog(userDataDir, {
      workspaceId: selectedWorkspace.id,
      sessionId: state.selectedSessionId,
    });
    const transcript = await readFile(sessionPath, "utf8");
    const entries = transcript
      .split(/\r?\n/)
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as { message?: { role?: string; provider?: string; model?: string } },
      );
    const routes = [
      ...new Set(
        entries
          .filter((entry) => entry.message?.role === "assistant")
          .map((entry) =>
            entry.message?.provider && entry.message.model
              ? `${entry.message.provider}/${entry.message.model}`
              : "",
          )
          .filter(Boolean),
      ),
    ];
    expect(routes).toEqual([route]);
    console.log(JSON.stringify({ route: routes[0], exactMarkerReturned: true }));
  } finally {
    await harness.close();
  }
});
