import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import { recordStudioCorrection, type StudioRun } from "../../contracts/studio-runs";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeGitWorkspace,
  makeWorkspace,
  runOrchestrationRuntimeTool,
  seedAgentDir,
} from "../helpers/electron-app";

async function startHangingOpenAiServer(): Promise<{
  readonly baseUrl: string;
  readonly pendingRequestCount: () => number;
  readonly releaseResponses: () => void;
  readonly close: () => Promise<void>;
}> {
  const pending = new Set<import("node:http").ServerResponse>();
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((request, response) => {
    if (request.url?.endsWith("/models")) {
      request.resume();
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "slow" }] }));
      return;
    }
    pending.add(response);
    response.on("close", () => pending.delete(response));
    request.resume();
    // Intentionally leave the response pending: create_child_thread must return
    // after the running acknowledgement rather than await this model turn.
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    pendingRequestCount: () => pending.size,
    releaseResponses: () => {
      for (const response of pending) {
        response.writeHead(200, {
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream",
        });
        const chunks = [
          {
            id: "chatcmpl-runtime-proof",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "slow",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "Worker complete." },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chatcmpl-runtime-proof",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "slow",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
        ];
        response.end(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
        );
      }
    },
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function selectedSessionRef(
  window: Parameters<typeof getDesktopState>[0],
): Promise<SessionRef> {
  const state = await getDesktopState(window);
  if (!state.selectedWorkspaceId || !state.selectedSessionId) {
    throw new Error("Expected a selected session");
  }
  return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId };
}

test("Studio plan tools persist a project run and restore it after app restart", async () => {
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeGitWorkspace("studio-run-persistence");
  await seedAgentDir(agentDir, { withOpenAiAuth: false });
  let harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Studio plan persistence proof");
    const parentRef = await selectedSessionRef(window);
    const state = await getDesktopState(window);
    const workspace = state.workspaces.find(({ id }) => id === parentRef.workspaceId);
    if (!workspace) throw new Error("Expected project workspace");
    const now = new Date().toISOString();
    const run: StudioRun = {
      id: "studio-persistence-proof",
      workspaceId: workspace.id,
      repositoryPath: workspace.path,
      specification: "Preserve this entire master specification across restart.",
      mode: "observed",
      status: "draft",
      milestones: [
        {
          id: "m1",
          title: "First milestone",
          instruction: "A bounded synthetic milestone.",
          dependsOn: [],
          status: "queued",
          workerThreadIds: [],
          worktreeIds: [],
          deliveryRequirement: "github-pr",
          updatedAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    const saved = await runOrchestrationRuntimeTool(harness, {
      toolName: "save_studio_run",
      toolCallId: "save-studio-run-proof",
      sessionRef: parentRef,
      params: { run },
    });
    expect(saved.details).toMatchObject({ action: "pi_gui_save_studio_run", runId: run.id });
    expect((await getDesktopState(window)).studioRuns).toContainEqual(
      expect.objectContaining({ ...run, specificationRevision: 1, corrections: [] }),
    );
    const forgedCorrection = recordStudioCorrection(run, {
      id: "model-forged-correction",
      instruction: "A model must not attribute this to Matthew.",
    });
    await expect(
      runOrchestrationRuntimeTool(harness, {
        toolName: "save_studio_run",
        toolCallId: "model-forged-studio-correction",
        sessionRef: parentRef,
        params: { run: forgedCorrection },
      }),
    ).rejects.toThrow("Matthew's authorised UI path");
    expect((await getDesktopState(window)).studioRuns[0]?.corrections).toEqual([]);
    await harness.close();

    harness = await launchDesktop(userDataDir, {
      agentDir,
      initialWorkspaces: [workspacePath],
      scrubProviderEnv: true,
      testMode: "background",
    });
    const restartedWindow = await harness.firstWindow();
    const restartedRef = await selectedSessionRef(restartedWindow);
    expect((await getDesktopState(restartedWindow)).studioRuns).toContainEqual(
      expect.objectContaining({ ...run, specificationRevision: 1, corrections: [] }),
    );
    const listed = await runOrchestrationRuntimeTool(harness, {
      toolName: "list_studio_runs",
      toolCallId: "list-studio-runs-proof",
      sessionRef: restartedRef,
      params: {},
    });
    expect(listed.details).toMatchObject({
      project: { workspaceId: restartedRef.workspaceId, repositoryPath: workspace.path },
    });
    expect(listed.details?.runs).toContainEqual(
      expect.objectContaining({ ...run, specificationRevision: 1, corrections: [] }),
    );
    expect(JSON.parse(await readFile(join(userDataDir, "studio-runs.json"), "utf8"))).toMatchObject(
      {
        version: 1,
        runs: [expect.objectContaining({ id: run.id, revision: 1 })],
      },
    );
  } finally {
    await harness.close();
  }
});

test("create_child_thread returns after a slow worker starts, before its turn completes", async () => {
  test.setTimeout(60_000);
  const proofDir = process.env.PI_APP_ORCHESTRATION_PROOF_DIR?.trim();
  if (proofDir) {
    await mkdir(proofDir, { recursive: true });
  }
  const server = await startHangingOpenAiServer();
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeGitWorkspace("orchestration-runtime-start-ack");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["slow-test/slow"],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: "slow-test",
        defaultModel: "slow",
        enabledModels: ["slow-test/slow"],
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
          "slow-test": {
            baseUrl: server.baseUrl,
            api: "openai-completions",
            apiKey: "unused",
            models: [{ id: "slow" }],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Parent orchestration thread");
    const parentRef = await selectedSessionRef(window);
    const initialState = await getDesktopState(window);
    const parentWorkspace = initialState.workspaces.find(({ id }) => id === parentRef.workspaceId);
    if (!parentWorkspace) throw new Error("Expected the parent project workspace");
    const now = new Date().toISOString();
    const studioRun: StudioRun = {
      id: "studio-worker-route-proof",
      workspaceId: parentWorkspace.id,
      repositoryPath: parentWorkspace.path,
      coordinatorSessionId: parentRef.sessionId,
      specification: "Show the actual route and worktree used by its worker.",
      mode: "observed",
      status: "running",
      milestones: [
        {
          id: "worker-route-milestone",
          title: "Route visibility",
          instruction: "Use one role-selected child worker.",
          dependsOn: [],
          status: "running",
          workerThreadIds: [],
          worktreeIds: [],
          deliveryRequirement: "github-pr",
          updatedAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    await runOrchestrationRuntimeTool(harness, {
      toolName: "save_studio_run",
      toolCallId: "save-studio-worker-route-proof",
      sessionRef: parentRef,
      params: { run: studioRun },
    });
    const prompt = "Keep this delegated worker running slowly.";
    await expect(
      runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: "create-child-forced-local",
        sessionRef: parentRef,
        params: {
          prompt,
          task_id: "studio-runtime-proof-local-attempt",
          role: "IMPLEMENTER",
          environment: "local",
        },
      }),
    ).rejects.toThrow(/require a managed worktree/i);
    await expect(
      runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: "create-child-studio-missing-task-id",
        sessionRef: parentRef,
        params: {
          prompt,
          role: "IMPLEMENTER",
          provider: "slow-test",
          model_id: "slow",
          thinking_level: "low",
          environment: "worktree",
        },
      }),
    ).rejects.toThrow(/requires a stable task_id/i);
    // The server never answers, so the child's first turn cannot complete. A tool
    // that awaited the turn would never return, and the test timeout names this step.
    const result = await test.step("create_child_thread returns while the turn is in flight", () =>
      runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: "create-child-start-ack",
        sessionRef: parentRef,
        params: {
          prompt,
          task_id: "runtime-proof-child",
          role: "IMPLEMENTER",
          provider: "slow-test",
          model_id: "slow",
          thinking_level: "low",
        },
      }));

    expect(result.details).toMatchObject({
      deliveryStatus: "running",
      prompt,
      taskId: "runtime-proof-child",
      role: "IMPLEMENTER",
      provider: "slow-test",
      modelId: "slow",
      thinkingLevel: "low",
      environment: "worktree",
      branchName: expect.stringMatching(/^pi\//),
    });
    // The worker's model request reached the server and is still unanswered.
    await expect.poll(() => server.pendingRequestCount()).toBeGreaterThan(0);
    const child = (await getDesktopState(window)).orchestrationChildren.find(
      (entry) => entry.sourceToolCallId === "create-child-start-ack",
    );
    expect(child?.status).toBe("running");
    expect(child).toMatchObject({
      taskId: "runtime-proof-child",
      role: "IMPLEMENTER",
      model: { provider: "slow-test", modelId: "slow" },
      thinkingLevel: "low",
      environment: "worktree",
      worktreePath: expect.any(String),
      branchName: expect.stringMatching(/^pi\//),
    });
    expect(child?.childWorkspaceId).not.toBe(parentRef.workspaceId);

    const duplicateTask = await runOrchestrationRuntimeTool(harness, {
      toolName: "create_child_thread",
      toolCallId: "replayed-child-with-new-tool-call-id",
      sessionRef: parentRef,
      params: {
        prompt,
        task_id: "runtime-proof-child",
        role: "IMPLEMENTER",
        provider: "slow-test",
        model_id: "slow",
        thinking_level: "low",
      },
    });
    expect(duplicateTask.details).toMatchObject({ childSessionId: child?.childSessionId });
    expect(
      (await getDesktopState(window)).orchestrationChildren.filter(
        (entry) => entry.taskId === "runtime-proof-child",
      ),
    ).toHaveLength(1);

    const savedRun = (await getDesktopState(window)).studioRuns.find(
      ({ id }) => id === studioRun.id,
    );
    if (!savedRun || !child) throw new Error("Expected the Studio run and worker record");
    await runOrchestrationRuntimeTool(harness, {
      toolName: "save_studio_run",
      toolCallId: "link-studio-worker-route-proof",
      sessionRef: parentRef,
      params: {
        run: {
          ...savedRun,
          revision: savedRun.revision + 1,
          updatedAt: new Date().toISOString(),
          milestones: savedRun.milestones.map((milestone) => ({
            ...milestone,
            workerThreadIds: [child.id],
          })),
        },
      },
    });
    await window.getByTestId("sidebar-studio").click();
    await expect(window.getByText("IMPLEMENTER", { exact: false })).toBeVisible();
    await expect(window.getByText("slow-test/slow", { exact: false })).toBeVisible();
    const workerList = window.getByRole("list", { name: "Route visibility workers" });
    await expect(workerList.getByText("· worktree", { exact: true })).toBeVisible();
    await expect(window.getByText(child.branchName!, { exact: true })).toBeVisible();
    await expect(window.getByText(child.worktreePath!, { exact: true })).toBeVisible();
    await window.getByRole("button", { name: "Open worker thread" }).click();
    await expect
      .poll(async () => (await getDesktopState(window)).selectedSessionId)
      .toBe(child.childSessionId);

    const replay = await runOrchestrationRuntimeTool(harness, {
      toolName: "create_child_thread",
      toolCallId: "create-child-start-ack",
      sessionRef: parentRef,
      params: {
        prompt,
        task_id: "runtime-proof-child",
        role: "IMPLEMENTER",
        provider: "slow-test",
        model_id: "slow",
        thinking_level: "low",
      },
    });
    expect(replay.details).toMatchObject({ childSessionId: child?.childSessionId });
    await expect(
      runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: "create-child-start-ack",
        sessionRef: parentRef,
        params: {
          prompt: "A different prompt must not reuse the original child.",
          task_id: "runtime-proof-child",
          role: "IMPLEMENTER",
          provider: "slow-test",
          model_id: "slow",
          thinking_level: "low",
        },
      }),
    ).rejects.toThrow(/already in use with different child thread settings/i);
    expect(
      (await getDesktopState(window)).orchestrationChildren.filter(
        (entry) => entry.taskId === "runtime-proof-child",
      ),
    ).toHaveLength(1);
    const second = await runOrchestrationRuntimeTool(harness, {
      toolName: "create_child_thread",
      toolCallId: "create-child-second",
      sessionRef: parentRef,
      params: {
        prompt: "Do a second independent bounded task.",
        task_id: "runtime-proof-child-two",
        role: "FAST_WORKER",
        provider: "slow-test",
        model_id: "slow",
      },
    });
    expect(second.details).toMatchObject({ environment: "worktree", deliveryStatus: "running" });
    await expect(
      runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: "create-child-third",
        sessionRef: parentRef,
        params: {
          prompt: "A third child must be rejected.",
          task_id: "studio-runtime-proof-third-child",
          role: "RESEARCHER",
        },
      }),
    ).rejects.toThrow(/at most 2 child threads/i);

    const waited = await runOrchestrationRuntimeTool(harness, {
      toolName: "wait_for_child_threads",
      toolCallId: "wait-child-timeout",
      sessionRef: parentRef,
      params: { thread_ids: [String(child?.id)], timeout_ms: 50 },
    });
    expect(waited.details).toMatchObject({ timedOut: true });
    expect(waited.details?.threads).toEqual(
      expect.arrayContaining([expect.objectContaining({ threadId: child?.id, status: "running" })]),
    );
    const childRunningIndicator = window.locator(
      `.session-row[data-session-id="${child?.childSessionId}"] .session-row__status--running`,
    );
    await expect(childRunningIndicator).toBeVisible();
    if (proofDir) {
      await window.screenshot({
        path: join(proofDir, "orchestration-child-running.png"),
        fullPage: true,
      });
    }
    const completionWait = runOrchestrationRuntimeTool(harness, {
      toolName: "wait_for_child_threads",
      toolCallId: "wait-child-completion",
      sessionRef: parentRef,
      params: { thread_ids: [String(child?.id)], timeout_ms: 5_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    server.releaseResponses();
    const completed = await completionWait;
    const completionTranscript = await runOrchestrationRuntimeTool(harness, {
      toolName: "read_thread",
      toolCallId: "read-child-completion",
      sessionRef: parentRef,
      params: { thread_id: child?.id },
    });
    expect(completionTranscript.content.map((entry) => entry.text ?? "").join("\n")).toContain(
      "Worker complete.",
    );
    expect(completed.details?.threads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: child?.id, status: "complete" }),
      ]),
    );
  } finally {
    await harness.close();
    await server.close();
  }
  const persistedState = JSON.parse(await readFile(join(userDataDir, "ui-state.json"), "utf8")) as {
    orchestrationChildren?: readonly Record<string, unknown>[];
  };
  expect(persistedState.orchestrationChildren).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        taskId: "runtime-proof-child",
        role: "IMPLEMENTER",
        model: { provider: "slow-test", modelId: "slow" },
        environment: "worktree",
        branchName: expect.stringMatching(/^pi\//),
      }),
    ]),
  );
});

test("create_child_thread surfaces deterministic initial-prompt delivery failures", async () => {
  test.setTimeout(60_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("orchestration-runtime-tools");
  await seedAgentDir(agentDir, { withOpenAiAuth: false });
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Parent orchestration thread");
    const parentRef = await selectedSessionRef(window);
    const prompt = "Child must start this delegated task.";

    await expect(
      runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: "create-child-delivery-failure",
        sessionRef: parentRef,
        params: { prompt },
      }),
    ).rejects.toThrow(/API key|authentication|credential/i);

    const state = await getDesktopState(window);
    const matchingChildren = state.orchestrationChildren.filter(
      (entry) => entry.sourceToolCallId === "create-child-delivery-failure",
    );
    expect(matchingChildren).toHaveLength(1);
    expect(matchingChildren[0]?.status).toBe("failed");
    expect(matchingChildren[0]?.latestTranscript).toMatch(/API key|authentication|credential/i);
    expect(matchingChildren[0]?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Initial prompt delivery failed", status: "failed" }),
      ]),
    );

    // Replaying the same tool call must re-surface the failed launch, not treat
    // the already-created session record as proof of success or create a duplicate.
    await expect(
      runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: "create-child-delivery-failure",
        sessionRef: parentRef,
        params: { prompt },
      }),
    ).rejects.toThrow(/API key|authentication|credential/i);
    expect(
      (await getDesktopState(window)).orchestrationChildren.filter(
        (entry) => entry.sourceToolCallId === "create-child-delivery-failure",
      ),
    ).toHaveLength(1);
  } finally {
    await harness.close();
  }
});
