import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  launchDesktopByExecutable,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("Studio role preferences save a supported thinking level without changing the current thread", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir("pi-gui-studio-role-preferences-");
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("studio-role-preferences");
  await seedAgentDir(agentDir);
  const extensionDir = join(agentDir, "extensions", "matthew-way-studio");
  await mkdir(extensionDir, { recursive: true });
  await copyFile(
    resolve("examples/desktop-extensions/matthew-way-studio/index.ts"),
    join(extensionDir, "index.ts"),
  );
  const preferencesPath = join(agentDir, "studio-models.json");
  await writeFile(
    preferencesPath,
    `${JSON.stringify({ version: 1, roles: { IMPLEMENTER: "openai/gpt-5" } }, null, 2)}\n`,
  );

  const launchOptions = {
    agentDir,
    initialWorkspaces: [workspacePath],
    testMode: "background" as const,
  };
  const installedExecutable = process.env.PI_APP_STUDIO_TEST_EXECUTABLE;
  const harness = installedExecutable
    ? await launchDesktopByExecutable(installedExecutable, userDataDir, launchOptions)
    : await launchDesktop(userDataDir, launchOptions);

  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Studio role preference test");
    const stateBefore = await getDesktopState(window);
    const sessionBefore = stateBefore.workspaces
      .find((entry) => entry.id === workspace.id)
      ?.sessions.find((entry) => entry.id === stateBefore.selectedSessionId);
    expect(sessionBefore).toBeTruthy();

    const composer = window.getByTestId("composer");
    await composer.fill("/studio models ");
    await composer.press("Enter");

    const dialog = window.getByTestId("extension-dialog");
    await expect(dialog).toContainText("Choose a role to configure");
    await dialog.getByRole("button", { name: "IMPLEMENTER", exact: true }).click();
    await expect(dialog).toContainText("Choose the preferred model for IMPLEMENTER");
    await dialog.getByRole("button", { name: "GPT-5 — openai/gpt-5", exact: true }).click();
    await expect(dialog).toContainText("Choose the preferred thinking level for IMPLEMENTER");
    await expect(dialog).toContainText("Use model default");
    const mediumOption = dialog.getByRole("button", { name: "medium", exact: true });
    const chosenLevel = (await mediumOption.count()) > 0 ? "medium" : "Use model default";
    await dialog.getByRole("button", { name: chosenLevel, exact: true }).click();

    const confirmation = window.getByRole("dialog", { name: "Save future-task role preference?" });
    await expect(confirmation).toContainText("This affects future Studio workers only");
    await confirmation.getByTestId("extension-dialog-confirm").click();
    await expect(window.locator(".timeline")).toContainText("Saved IMPLEMENTER");

    const saved = JSON.parse(await readFile(preferencesPath, "utf8")) as {
      version: number;
      roles: Record<string, { model: string; thinkingLevel: string }>;
    };
    expect(saved.version).toBe(2);
    expect(saved.roles.IMPLEMENTER).toMatchObject({
      model: "openai/gpt-5",
      thinkingLevel: chosenLevel === "medium" ? "medium" : "default",
    });
    const stateAfter = await getDesktopState(window);
    const sessionAfter = stateAfter.workspaces
      .find((entry) => entry.id === workspace.id)
      ?.sessions.find((entry) => entry.id === stateAfter.selectedSessionId);
    expect(sessionAfter?.config).toEqual(sessionBefore?.config);
  } finally {
    await harness.close();
  }
});
