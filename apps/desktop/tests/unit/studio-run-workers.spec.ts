import { expect, test } from "@playwright/test";
import type { OrchestrationChildThread } from "../../contracts/desktop-state";
import type { StudioMilestone, StudioRun } from "../../contracts/studio-runs";
import { studioRunWorkerRows } from "../../src/features/studio/studio-run-workers";

const run: StudioRun = {
  id: "run-1",
  workspaceId: "workspace-1",
  repositoryPath: "C:\\scratch\\repo",
  coordinatorSessionId: "coordinator-1",
  specification: "Implement and verify a small feature.",
  mode: "observed",
  status: "running",
  milestones: [],
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:00:00.000Z",
  revision: 1,
};

const milestone: StudioMilestone = {
  id: "milestone-1",
  title: "Implement feature",
  instruction: "Implement this bounded change.",
  dependsOn: [],
  status: "running",
  workerThreadIds: ["worker-1", "unloaded-worker"],
  worktreeIds: [],
  deliveryRequirement: "github-pr",
  updatedAt: "2026-09-29T00:00:00.000Z",
};

function child(overrides: Partial<OrchestrationChildThread>): OrchestrationChildThread {
  return {
    id: "worker-1",
    taskId: "task-1",
    role: "IMPLEMENTER",
    model: { provider: "qwen-token-plan", modelId: "qwen3.8-max" },
    environment: "worktree",
    parentWorkspaceId: "workspace-1",
    parentSessionId: "coordinator-1",
    childWorkspaceId: "worktree-1",
    childSessionId: "session-1",
    worktreePath: "C:\\scratch\\repo-worker",
    branchName: "studio/feature",
    title: "Feature worker",
    goal: "Implement this bounded change.",
    status: "running",
    latestTranscript: "Working.",
    transcript: [],
    evidence: [],
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    ...overrides,
  };
}

test("Studio resolves exact worker route and worktree only within the owning coordinator", () => {
  const owned = child({});
  const otherRun = child({
    id: "unloaded-worker",
    parentSessionId: "another-coordinator",
    taskId: "other-task",
    model: { provider: "wrong-provider", modelId: "wrong-model" },
  });

  const rows = studioRunWorkerRows(run, milestone, [owned, otherRun]);

  expect(rows).toEqual([
    { workerId: "worker-1", child: owned },
    { workerId: "unloaded-worker", child: undefined },
  ]);
  expect(rows[0]?.child).toMatchObject({
    role: "IMPLEMENTER",
    model: { provider: "qwen-token-plan", modelId: "qwen3.8-max" },
    branchName: "studio/feature",
    worktreePath: "C:\\scratch\\repo-worker",
  });
});
