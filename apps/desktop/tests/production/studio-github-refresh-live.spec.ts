import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { StudioRun } from "../../contracts/studio-runs";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  launchDesktopByExecutable,
  makeGitWorkspace,
  makeUserDataDir,
  seedAgentDir,
} from "../helpers/electron-app";
import {
  scriptedText,
  scriptedToolCall,
  startScriptedOpenAiServer,
  toolExchanges,
  userText,
  type ScriptedActor,
  type ScriptedRequestContext,
} from "../helpers/scripted-openai-provider";

const refreshRequest = "Attach the configured GitHub pull request to this Studio plan.";

function requireConfiguration(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before running this opt-in GitHub GUI check.`);
  return value;
}

function studioRunActor(getRun: () => StudioRun | undefined): ScriptedActor {
  return {
    name: "studio-github-checkpoint",
    matches: (context) => userText(context).includes(refreshRequest),
    respond: (context) => {
      const exchanges = toolExchanges(context);
      if (exchanges.some(({ name }) => name === "save_studio_run")) {
        return scriptedText("The pull request URL is attached to the draft plan.");
      }
      const run = getRun();
      if (!run) throw new Error("The GUI has not created the Studio draft yet.");
      if (!context.toolNames.includes("save_studio_run")) {
        throw new Error("Pi did not expose save_studio_run to the Studio coordinator thread.");
      }
      const milestone = run.milestones[0];
      if (!milestone) throw new Error("The GUI-created Studio plan has no milestone.");
      return scriptedToolCall("save_studio_run", {
        run: {
          id: run.id,
          workspaceId: run.workspaceId,
          repositoryPath: run.repositoryPath,
          specification: run.specification,
          mode: run.mode,
          status: run.status,
          ...(run.specificationRevision === undefined
            ? {}
            : { specificationRevision: run.specificationRevision }),
          ...(run.corrections === undefined ? {} : { corrections: run.corrections }),
          revision: run.revision + 1,
          updatedAt: new Date().toISOString(),
          createdAt: run.createdAt,
          milestones: [
            {
              id: milestone.id,
              title: milestone.title,
              instruction: milestone.instruction,
              dependsOn: milestone.dependsOn,
              status: milestone.status,
              workerThreadIds: milestone.workerThreadIds,
              worktreeIds: milestone.worktreeIds,
              pullRequestUrl: requireConfiguration("PI_APP_STUDIO_GITHUB_PR_URL"),
              updatedAt: new Date().toISOString(),
            },
          ],
        },
      });
    },
  };
}

test("Studio GUI refreshes a saved pull request from live GitHub state", async () => {
  test.setTimeout(180_000);
  const pullRequestUrl = requireConfiguration("PI_APP_STUDIO_GITHUB_PR_URL");
  const expectedHeadSha = requireConfiguration("PI_APP_STUDIO_EXPECTED_HEAD_SHA");
  const expectedReviewStatus =
    process.env.PI_APP_STUDIO_EXPECTED_REVIEW_STATUS?.trim() || "awaiting-lucy";
  const expectedMergeCommitSha = process.env.PI_APP_STUDIO_EXPECTED_MERGE_SHA?.trim();
  expect(expectedHeadSha).toMatch(/^[0-9a-f]{40}$/i);
  expect(pullRequestUrl).toMatch(/^https:\/\/github\.com\/.+\/pull\/\d+\/?$/);
  expect(["awaiting-lucy", "merged"]).toContain(expectedReviewStatus);
  if (expectedReviewStatus === "merged") expect(expectedMergeCommitSha).toMatch(/^[0-9a-f]{40}$/i);

  let draftRun: StudioRun | undefined;
  const server = await startScriptedOpenAiServer([studioRunActor(() => draftRun)]);
  const workspacePath = await makeGitWorkspace("studio-github-refresh-live");
  const userDataDir = await makeUserDataDir("pi-gui-studio-github-refresh-");
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: [`studio-fixture/${server.modelId}`],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: "studio-fixture",
        defaultModel: server.modelId,
        enabledModels: [`studio-fixture/${server.modelId}`],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          "studio-fixture": {
            baseUrl: server.baseUrl,
            api: "openai-completions",
            apiKey: "unused",
            models: [{ id: server.modelId }],
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const launchOptions = {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  } as const;
  const installedExecutable = process.env.PI_APP_STUDIO_TEST_EXECUTABLE?.trim();
  const harness = installedExecutable
    ? await launchDesktopByExecutable(installedExecutable, userDataDir, launchOptions)
    : await launchDesktop(userDataDir, launchOptions);
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "GitHub refresh verification");
    await window.getByTestId("sidebar-studio").click();
    await expect(window.getByTestId("studio-runs-view")).toBeVisible();
    await window
      .getByLabel("Specification or implementation packet")
      .fill("Verify the GitHub checkpoint refresh path in this disposable project.");
    await window.getByRole("button", { name: "Save draft", exact: true }).click();

    await expect.poll(async () => (await getDesktopState(window)).studioRuns.length).toBe(1);
    const initialState = await getDesktopState(window);
    draftRun = initialState.studioRuns[0];
    expect(draftRun).toBeDefined();
    expect(draftRun?.status).toBe("draft");

    await window
      .locator(".session-row__select", { hasText: "GitHub refresh verification" })
      .click();
    await window.getByTestId("composer").fill(refreshRequest);
    await window.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(
      window.locator(".timeline-item--assistant .message__content").last(),
    ).toContainText("attached to the draft plan", { timeout: 30_000 });
    await expect
      .poll(
        async () => (await getDesktopState(window)).studioRuns[0]?.milestones[0]?.pullRequestUrl,
      )
      .toBe(pullRequestUrl);

    await window.getByRole("button", { name: "Threads" }).click();
    await window.getByTestId("sidebar-studio").click();
    await expect.poll(async () => (await getDesktopState(window)).activeView).toBe("studio");
    await expect(window.getByTestId("studio-runs-view")).toBeVisible();
    const reviewCard = window.getByTestId("studio-github-pull-request");
    await expect(reviewCard).toBeVisible();
    await reviewCard.getByRole("button", { name: "Refresh from GitHub" }).click();
    await expect(reviewCard).toContainText(`HEAD ${expectedHeadSha}`, { timeout: 30_000 });
    await expect(reviewCard).toContainText(expectedReviewStatus);

    const refreshed = await getDesktopState(window);
    const milestone = refreshed.studioRuns[0]?.milestones[0];
    const checkpoint = milestone?.githubCheckpoints?.at(-1);
    expect(checkpoint).toMatchObject({
      pullRequestUrl,
      headSha: expectedHeadSha,
    });
    if (expectedReviewStatus === "merged") {
      expect(checkpoint?.reviewHistory.at(-1)).toMatchObject({
        decision: "merged",
        reviewedHeadSha: expectedHeadSha,
        source: "github-api",
        mergeCommitSha: expectedMergeCommitSha,
      });
      expect(checkpoint?.reviewHistory.at(-1)?.mergedAt).toBeTruthy();
    } else {
      expect(checkpoint).not.toHaveProperty("mergeCommitSha");
      expect(checkpoint?.reviewHistory ?? []).toHaveLength(0);
    }
    expect(refreshed.studioRuns[0]?.status).toBe("draft");
    console.log(
      JSON.stringify({
        guiRefreshClicked: true,
        pullRequestUrl,
        headSha: checkpoint?.headSha,
        mergeObserved: expectedReviewStatus === "merged",
        reviewStatus: expectedReviewStatus,
        provider: "local-scripted-fixture",
        githubOperation: "read-only gh api",
      }),
    );
  } finally {
    await harness.close();
    await server.close();
  }
});
