import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  desktopShortcut,
  getDesktopState,
  launchPackagedDesktop,
  makeUserDataDir,
  makeWorkspace,
  selectSidePanel,
  waitForWorkspaceByPath,
} from "../helpers/electron-app";

test("packaged app uses configured PowerShell 7 in its integrated terminal", async () => {
  test.setTimeout(60_000);

  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("packaged-terminal");
  const harness = await launchPackagedDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await createNamedThread(window, "Packaged terminal thread");

    await window.keyboard.press(desktopShortcut(","));
    await expect(window.getByTestId("settings-surface")).toBeVisible();
    await window.getByRole("button", { name: "General", exact: true }).click();
    const shellInput = window.getByLabel("Shell of integrated terminal");
    await shellInput.fill("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    await shellInput.press("Enter");
    await expect
      .poll(async () => (await getDesktopState(window)).integratedTerminalShell)
      .toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    await window.getByRole("button", { name: "Back to app", exact: true }).click();

    await selectSidePanel(window, "Terminal");
    const terminal = window.getByTestId("integrated-terminal");
    await expect(terminal).toBeVisible();
    await terminal.locator(".xterm").click();
    await window.keyboard.type(
      'Write-Output ("PI_PS_VERSION=" + $PSVersionTable.PSVersion.ToString()); Get-Command git,gh,rg,sg,threadmoth -ErrorAction SilentlyContinue | ForEach-Object { Write-Output ("PI_TOOL=" + $_.Name) }',
    );
    await window.keyboard.press("Enter");
    const rows = terminal.locator(".xterm-rows");
    await expect(rows).toContainText(/PI_PS_VERSION=7\.\d+\.\d+/, { timeout: 15_000 });
    for (const tool of ["git", "gh", "rg", "sg", "threadmoth"]) {
      await expect(rows).toContainText(`PI_TOOL=${tool}`);
    }
  } finally {
    await harness.close();
  }
});
