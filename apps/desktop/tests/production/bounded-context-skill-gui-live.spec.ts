import { cp, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchPackagedDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";
import { sessionFilePathFromCatalog } from "../helpers/session-file";

function assistantRoute(entry: unknown): string | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const message = (entry as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  const record = message as Record<string, unknown>;
  if (
    record.role !== "assistant" ||
    typeof record.provider !== "string" ||
    typeof record.model !== "string"
  ) {
    return undefined;
  }
  return `${record.provider}/${record.model}`;
}

test("installed Pi GUI Try invokes bounded-context on Qwen Token Plan Max", async () => {
  test.skip(
    process.env.PI_APP_RUN_SKILL_LIVE !== "1",
    "Set PI_APP_RUN_SKILL_LIVE=1 to make one authenticated Qwen Token Plan request.",
  );
  test.setTimeout(300_000);

  const sourceAgentDir = join(homedir(), ".pi", "agent");
  const userDataDir = await makeUserDataDir("pi-gui-bounded-context-skill-");
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("bounded-context-skill-live");
  const command = "/skill:bounded-context";
  const instruction =
    "Treat cached or distilled results as valid only while their dependencies remain unchanged.";
  await mkdir(agentDir, { recursive: true });
  await cp(join(sourceAgentDir, "skills", "matthew-way"), join(agentDir, "skills", "matthew-way"), {
    recursive: true,
  });
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
    // Create a blank session through the GUI runtime, avoiding an unrelated
    // model call before Skills → Try has prepared the actual test request.
    await createNamedThread(window, "Bounded-context skill verification");

    await window.getByRole("button", { name: "Skills", exact: true }).click();
    await expect
      .poll(async () => (await getDesktopState(window)).activeView, { timeout: 30_000 })
      .toBe("skills");
    await expect(window.getByTestId("skills-surface")).toBeVisible({ timeout: 30_000 });
    await window.getByRole("searchbox", { name: "Search skills" }).fill("bounded-context");
    const skills = window.getByTestId("skills-list");
    await expect(skills).toContainText("Bounded Context");
    await window.getByRole("button", { name: /Bounded Context/i }).click();
    await expect(window.locator(".skill-detail")).toContainText(command);
    await window.getByRole("button", { name: "Try", exact: true }).click();
    const composer = window.getByTestId("composer");
    await expect(composer).toHaveValue(`${command} `);

    const request =
      "Use the skill just invoked. In one sentence, state the skill's rule for when cached or distilled results remain valid. Do not use tools or inspect other files.";
    await composer.fill(`${command} ${request}`);
    const startedAt = Date.now();
    await window.getByRole("button", { name: "Send message", exact: true }).click();
    const assistant = window.locator(".timeline-item--assistant .message__content").last();
    await expect(assistant).toContainText(/dependencies remain unchanged/i, { timeout: 180_000 });
    const response = await assistant.innerText();

    const state = await getDesktopState(window);
    const selectedWorkspace = state.workspaces.find(({ id }) => id === state.selectedWorkspaceId);
    if (!selectedWorkspace || !state.selectedSessionId)
      throw new Error("No selected skill-test session");
    const sessionPath = await sessionFilePathFromCatalog(userDataDir, {
      workspaceId: selectedWorkspace.id,
      sessionId: state.selectedSessionId,
    });
    const transcript = await readFile(sessionPath, "utf8");
    const entries = transcript
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
    const routes = [
      ...new Set(
        entries.map(assistantRoute).filter((route): route is string => route !== undefined),
      ),
    ];
    expect(routes).toEqual(["qwen-token-plan/qwen3.8-max"]);
    expect(transcript).toContain(request);
    expect(transcript).toContain(instruction);
    expect(response).toMatch(
      /cached or distilled results remain valid only while their dependencies remain unchanged/i,
    );
    console.log(
      JSON.stringify({
        route: routes[0],
        tryInsertedCommand: command,
        transcriptContainsExactSkillInstruction: transcript.includes(instruction),
        responseMatchesLoadedRule: true,
        promptToResponseMs: Date.now() - startedAt,
      }),
    );
  } finally {
    await harness.close();
  }
});
