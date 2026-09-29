import { expect, test } from "@playwright/test";
import {
  getDesktopState,
  createSessionViaIpc,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  runOrchestrationRuntimeTool,
  selectSession,
  waitForWorkspaceByPath,
  waitForSessionByTitle,
  writeProjectExtension,
} from "../helpers/electron-app";

const studioCommandFixture = String.raw`
export default function studioCommandFixture(pi) {
  pi.registerCommand("studio", {
    description: "Deterministic Studio command fixture",
    handler: async (args, ctx) => {
      ctx.ui.setEditorText(args.trim() === "start" ? "STUDIO_START_HANDLED" : "STUDIO_PLAN_HANDLED");
    },
  });
}
`;

test("Studio view records a prepared plan and does not fake a running state", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("studio-view");
  const first = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await first.firstWindow();
    await createSessionViaIpc(window, workspacePath, "Studio handoff target");
    await window.getByTestId("sidebar-studio").click();
    await expect(window.getByTestId("studio-runs-view")).toBeVisible();
    await window
      .getByLabel("Specification or implementation packet")
      .fill("Create a small project plan and verify persistence.");
    const prepareButton = window.getByRole("button", { name: "Prepare in current thread" });
    await expect(prepareButton).toBeEnabled();
    await prepareButton.click();
    await expect(window.getByRole("textbox", { name: "Composer" })).toHaveValue(
      "/studio Create a small project plan and verify persistence.",
    );
    await expect(window.getByRole("button", { name: "Send message" })).toBeVisible();
    await window.getByTestId("sidebar-studio").click();
    await expect(window.getByTestId("studio-runs-view")).toBeVisible();
    await expect(
      window.getByText("Create a small project plan and verify persistence."),
    ).toBeVisible();

    const draft = (await getDesktopState(window)).studioRuns[0];
    expect(draft).toMatchObject({ status: "draft", mode: "observed", revision: 1 });
    await expect(window.getByRole("button", { name: "Start in prepared thread" })).toBeEnabled();
    await expect(window.getByRole("button", { name: "Mark running" })).toHaveCount(0);
    expect((await getDesktopState(window)).studioRuns[0]).toMatchObject({
      status: "draft",
      coordinatorSessionId: (await getDesktopState(window)).selectedSessionId,
    });
  } finally {
    await first.close();
  }

  const second = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  try {
    const window = await second.firstWindow();
    await window.getByTestId("sidebar-studio").click();
    await expect(window.getByTestId("studio-run")).toContainText("draft");
    expect((await getDesktopState(window)).studioRuns[0]).toMatchObject({
      status: "draft",
      revision: 1,
    });
  } finally {
    await second.close();
  }
});

test("Studio Start submits to the prepared thread and records running only after dispatch", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("studio-start-target");
  await writeProjectExtension(workspacePath, "studio-command-fixture.ts", studioCommandFixture);
  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    const workspace = await waitForWorkspaceByPath(window, workspacePath);
    await createSessionViaIpc(window, workspacePath, "Prepared coordinator");
    await selectSession(window, "Prepared coordinator");
    const coordinator = await waitForSessionByTitle(window, workspace.id, "Prepared coordinator");
    const coordinatorKey = `${workspace.id}:${coordinator.id}`;
    await expect
      .poll(async () =>
        (await getDesktopState(window)).sessionCommandsBySession[coordinatorKey]?.some(
          (command) => command.name === "studio",
        ),
      )
      .toBe(true);

    await window.getByTestId("sidebar-studio").click();
    await window.getByLabel("Specification or implementation packet").fill("Pilot start route.");
    await window.getByRole("button", { name: "Prepare in current thread" }).click();
    await window.getByRole("button", { name: "Send message" }).click();
    await expect(window.getByRole("textbox", { name: "Composer" })).toHaveValue(
      "STUDIO_PLAN_HANDLED",
    );

    await window.getByTestId("sidebar-studio").click();
    await expect(window.getByRole("button", { name: "Start in prepared thread" })).toBeEnabled();
    await createSessionViaIpc(window, workspacePath, "Different selected thread");
    await selectSession(window, "Different selected thread");
    await window.getByTestId("sidebar-studio").click();
    await expect(window.getByRole("button", { name: "Start in prepared thread" })).toBeDisabled();

    await selectSession(window, "Prepared coordinator");
    await window.getByTestId("sidebar-studio").click();
    await window.getByRole("button", { name: "Start in prepared thread" }).click();
    await expect
      .poll(async () => (await getDesktopState(window)).composerDraft)
      .toBe("STUDIO_START_HANDLED");
    await expect
      .poll(async () => (await getDesktopState(window)).studioRuns[0]?.status)
      .toBe("running");
    expect((await getDesktopState(window)).studioRuns[0]).toMatchObject({
      coordinatorSessionId: coordinator.id,
      status: "running",
    });
    await selectSession(window, "Different selected thread");
    await window.getByTestId("sidebar-studio").click();
    await window.getByLabel("Live correction").fill("Include a short operations note.");
    const correctionInputRun = (await getDesktopState(window)).studioRuns[0]!;
    const expectedAffectedMilestoneIds = correctionInputRun.milestones
      .filter(({ status }) => status !== "complete" && status !== "cancelled")
      .map(({ id }) => id);
    await window.getByRole("button", { name: "Prepare correction in coordinator" }).click();
    await expect(window.locator(".chat-header__title")).toHaveText("Prepared coordinator");
    await expect(window.getByRole("textbox", { name: "Composer" })).toHaveValue(
      /\[LIVE CORRECTION for run studio-/,
    );
    expect((await getDesktopState(window)).studioRuns[0]).toMatchObject({
      status: "running",
      specificationRevision: 2,
      corrections: [
        {
          specificationRevision: 2,
          instruction: "Include a short operations note.",
          affectedMilestoneIds: expectedAffectedMilestoneIds,
          status: "prepared",
        },
      ],
    });

    await window.getByTestId("sidebar-studio").click();
    await expect(window.getByTestId("studio-runs-view")).toBeVisible();
    await window.getByRole("button", { name: "Pause new dispatch" }).click();
    await expect
      .poll(async () => (await getDesktopState(window)).studioRuns[0]?.status)
      .toBe("paused");
    await expect(
      runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: "studio-paused-dispatch-must-be-blocked",
        sessionRef: { workspaceId: workspace.id, sessionId: coordinator.id },
        params: { prompt: "This must wait until Studio resumes." },
      }),
    ).rejects.toThrow(/Studio run .* is paused/);
    await window.getByRole("button", { name: "Resume after reconciliation" }).click();
    await expect
      .poll(async () => (await getDesktopState(window)).studioRuns[0]?.status)
      .toBe("running");
    await expect(window.getByRole("textbox", { name: "Composer" })).toHaveValue(
      "STUDIO_START_HANDLED",
    );

    await window.getByTestId("sidebar-studio").click();
    await window.getByRole("button", { name: "Pause new dispatch" }).click();
    await expect
      .poll(async () => (await getDesktopState(window)).studioRuns[0]?.status)
      .toBe("paused");
    await window.getByRole("button", { name: "Stop run and cancel workers" }).click();
    await expect
      .poll(async () => (await getDesktopState(window)).studioRuns[0]?.status)
      .toBe("stopped");
    await expect(window.getByRole("textbox", { name: "Composer" })).toHaveValue(
      "STUDIO_START_HANDLED",
    );

    await expect(
      runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: "studio-stopped-dispatch-must-be-blocked",
        sessionRef: { workspaceId: workspace.id, sessionId: coordinator.id },
        params: { prompt: "This must not create a worker after Studio Stop." },
      }),
    ).rejects.toThrow(/Studio run .* is stopped/);
    expect((await getDesktopState(window)).orchestrationChildren).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceToolCallId: "studio-stopped-dispatch-must-be-blocked" }),
      ]),
    );
  } finally {
    await harness.close();
  }
});
