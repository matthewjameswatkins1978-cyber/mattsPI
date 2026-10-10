import { expect, test } from "@playwright/test";
import type { OrchestrationChildThread } from "../../contracts/desktop-state";
import type { StudioMilestone, StudioRun } from "../../contracts/studio-runs";
import { assertNewStudioMilestoneCompletionsHaveEvidence } from "../../electron/studio/studio-verification-gate";

const run = { workspaceId: "workspace-1", coordinatorSessionId: "coordinator-1" };
const milestone: StudioMilestone = {
  id: "milestone-1",
  title: "Implement the feature",
  instruction: "Implement the requested feature.",
  dependsOn: [],
  status: "verifying",
  workerThreadIds: ["inspector-1"],
  worktreeIds: [],
  deliveryRequirement: "github-pr",
  updatedAt: "2026-09-29T00:00:00.000Z",
};
const currentRun: StudioRun = {
  id: "run-1",
  workspaceId: run.workspaceId,
  repositoryPath: "C:\\scratch\\repo",
  coordinatorSessionId: run.coordinatorSessionId,
  specification: "Implement the requested feature.",
  mode: "observed",
  status: "running",
  milestones: [milestone],
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:00:00.000Z",
  revision: 1,
};
const completedRun = {
  ...currentRun,
  milestones: [{ ...milestone, status: "complete" as const }],
  updatedAt: "2026-09-29T00:03:00.000Z",
  revision: 2,
};

const inspector: OrchestrationChildThread = {
  id: "inspector-1",
  role: "independent-inspector",
  parentWorkspaceId: run.workspaceId,
  parentSessionId: run.coordinatorSessionId,
  childWorkspaceId: run.workspaceId,
  childSessionId: "inspector-session-1",
  title: "Inspect feature",
  goal: "Inspect and test milestone-1.",
  status: "complete",
  latestTranscript: "PASS",
  transcript: [
    {
      id: "report-1",
      role: "child",
      text: "PASS: reviewed the actual diff and the relevant test completed successfully.",
      createdAt: "2026-09-29T00:02:00.000Z",
    },
  ],
  evidence: [
    {
      id: "test-1",
      childThreadId: "inspector-1",
      kind: "command",
      source: "command",
      status: "passed",
      title: "Test command run",
      command: "pnpm test --filter feature",
      toolName: "powershell",
      createdAt: "2026-09-29T00:01:00.000Z",
    },
    {
      id: "read-1",
      childThreadId: "inspector-1",
      kind: "orchestrator_observation",
      source: "orchestrator-observed",
      status: "reported",
      title: "Orchestrator read child output",
      createdAt: "2026-09-29T00:02:00.000Z",
    },
    {
      id: "diff-1",
      childThreadId: "inspector-1",
      kind: "command",
      source: "command",
      status: "passed",
      title: "Command or tool run",
      command: "git diff --",
      toolName: "powershell",
      createdAt: "2026-09-29T00:01:30.000Z",
    },
  ],
  createdAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:02:00.000Z",
};

test.describe("Studio verification gate", () => {
  test("requires a linked, completed independent inspector with passing check evidence", () => {
    expect(() =>
      assertNewStudioMilestoneCompletionsHaveEvidence(undefined, completedRun, []),
    ).toThrow("independent-inspector child");
    expect(() =>
      assertNewStudioMilestoneCompletionsHaveEvidence(currentRun, completedRun, [
        { ...inspector, status: "running" },
      ]),
    ).toThrow("has not completed");
    expect(() =>
      assertNewStudioMilestoneCompletionsHaveEvidence(currentRun, completedRun, [
        { ...inspector, evidence: inspector.evidence.filter(({ id }) => id !== "test-1") },
      ]),
    ).toThrow("no successful specification-relevant check evidence");
    expect(() =>
      assertNewStudioMilestoneCompletionsHaveEvidence(currentRun, completedRun, [
        { ...inspector, evidence: inspector.evidence.filter(({ id }) => id !== "diff-1") },
      ]),
    ).toThrow("no successful Git diff/status inspection evidence");
    expect(() =>
      assertNewStudioMilestoneCompletionsHaveEvidence(currentRun, completedRun, [
        {
          ...inspector,
          transcript: [{ ...inspector.transcript[0]!, text: "INCONCLUSIVE: no test evidence." }],
        },
      ]),
    ).toThrow("explicit PASS verdict");
  });

  test("requires the coordinator to read the inspector result before acceptance", () => {
    expect(() =>
      assertNewStudioMilestoneCompletionsHaveEvidence(currentRun, completedRun, [
        { ...inspector, evidence: inspector.evidence.filter(({ id }) => id !== "read-1") },
      ]),
    ).toThrow("must read the independent-inspector thread");
  });

  test("accepts only evidence from the linked inspector under this coordinator", () => {
    expect(() =>
      assertNewStudioMilestoneCompletionsHaveEvidence(currentRun, completedRun, [inspector]),
    ).not.toThrow();
    expect(() =>
      assertNewStudioMilestoneCompletionsHaveEvidence(currentRun, completedRun, [
        { ...inspector, parentSessionId: "another-coordinator" },
      ]),
    ).toThrow("independent-inspector child");
    expect(() =>
      assertNewStudioMilestoneCompletionsHaveEvidence(
        currentRun,
        {
          ...completedRun,
          milestones: [{ ...completedRun.milestones[0]!, workerThreadIds: [] }],
        },
        [inspector],
      ),
    ).toThrow("independent-inspector child");
    expect(() =>
      assertNewStudioMilestoneCompletionsHaveEvidence(
        { ...currentRun, milestones: completedRun.milestones },
        completedRun,
        [],
      ),
    ).not.toThrow();
  });


  test("allows host-authorised coordinator verification only with parent test/git evidence and exact PASS marker", () => {
    const coordinatorMilestone: StudioMilestone = {
      ...milestone,
      status: "verifying",
      workerThreadIds: [],
      worktreeIds: [],
      deliveryRequirement: "local",
      verificationRequirement: "coordinator",
    };
    const coordinatorRun: StudioRun = {
      ...currentRun,
      milestones: [coordinatorMilestone],
    };
    const completedCoordinatorRun: StudioRun = {
      ...coordinatorRun,
      milestones: [{ ...coordinatorMilestone, status: "complete" }],
      revision: coordinatorRun.revision + 1,
    };
    const transcript = [
      {
        kind: "tool",
        id: "tool-test",
        callId: "tool-test",
        toolName: "powershell",
        status: "success",
        label: "Test",
        createdAt: "2026-09-29T00:01:00.000Z",
        input: { command: "cargo test --all" },
      },
      {
        kind: "tool",
        id: "tool-git",
        callId: "tool-git",
        toolName: "powershell",
        status: "success",
        label: "Git status",
        createdAt: "2026-09-29T00:01:30.000Z",
        input: { command: "git status --short" },
      },
      {
        kind: "message",
        id: "assistant-pass",
        role: "assistant",
        text: "COORDINATOR-VERIFIED: milestone-1 PASS",
        createdAt: "2026-09-29T00:02:00.000Z",
      },
    ];

    expect(() =>
      assertNewStudioMilestoneCompletionsHaveEvidence(
        coordinatorRun,
        completedCoordinatorRun,
        [],
        transcript as never,
      ),
    ).not.toThrow();

    expect(() =>
      assertNewStudioMilestoneCompletionsHaveEvidence(
        coordinatorRun,
        completedCoordinatorRun,
        [],
        transcript.slice(1) as never,
      ),
    ).toThrow("no successful specification-relevant check evidence");

    expect(() =>
      assertNewStudioMilestoneCompletionsHaveEvidence(
        coordinatorRun,
        completedCoordinatorRun,
        [],
        transcript.filter((entry: { id: string }) => entry.id !== "tool-git") as never,
      ),
    ).toThrow("no successful Git diff/status inspection evidence");
  });

  test("never downgrades delegated work to coordinator verification", () => {
    const coordinatorMilestone: StudioMilestone = {
      ...milestone,
      status: "verifying",
      workerThreadIds: ["worker-1"],
      worktreeIds: [],
      deliveryRequirement: "local",
      verificationRequirement: "coordinator",
    };
    const coordinatorRun: StudioRun = {
      ...currentRun,
      milestones: [coordinatorMilestone],
    };
    const completedCoordinatorRun: StudioRun = {
      ...coordinatorRun,
      milestones: [{ ...coordinatorMilestone, status: "complete" }],
      revision: coordinatorRun.revision + 1,
    };
    expect(() =>
      assertNewStudioMilestoneCompletionsHaveEvidence(
        coordinatorRun,
        completedCoordinatorRun,
        [],
        [] as never,
      ),
    ).toThrow("requires an independent-inspector child");
  });
});
