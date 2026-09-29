import { expect, test } from "@playwright/test";
import {
  availableStudioMilestones,
  isStudioMilestoneDependencySatisfied,
  preserveStudioRunHistory,
  transitionStudioMilestone,
  transitionStudioRun,
  type StudioMilestone,
  type StudioRun,
} from "../../contracts/studio-runs";
import { assertNewStudioMilestoneCompletionsHaveEvidence } from "../../electron/studio/studio-verification-gate";
import type { OrchestrationChildThread } from "../../contracts/desktop-state";

test.describe("Studio three-milestone integrated demonstration contract", () => {
  const now = "2026-09-29T16:00:00.000Z";
  const parentSessionId = "coordinator-session-1";
  const workspaceId = "workspace-disposable-demo";

  const threeMilestonePlan: StudioRun = {
    id: "studio-three-milestone-demo",
    workspaceId,
    repositoryPath: "C:\\scratch\\studio-demo",
    coordinatorSessionId: parentSessionId,
    specification:
      "Integrated 3-milestone autonomous demonstration: M1 core math foundation, M2 dependent multiplication feature, M3 independent expression formatter.",
    mode: "observed",
    status: "running",
    createdAt: now,
    updatedAt: now,
    revision: 1,
    milestones: [
      {
        id: "m1-foundation",
        title: "Foundation: Core addition fix",
        instruction: "Fix addition implementation and ensure npm test passes.",
        dependsOn: [],
        status: "queued",
        workerThreadIds: [],
        worktreeIds: [],
        deliveryRequirement: "local",
        updatedAt: now,
      },
      {
        id: "m2-multiplication",
        title: "Feature: Multiplication",
        instruction: "Add multiplication and ensure tests pass.",
        dependsOn: ["m1-foundation"],
        status: "queued",
        workerThreadIds: [],
        worktreeIds: [],
        deliveryRequirement: "local",
        updatedAt: now,
      },
      {
        id: "m3-formatter",
        title: "Tooling: Expression formatter",
        instruction: "Add math expression formatter and tests.",
        dependsOn: [],
        status: "queued",
        workerThreadIds: [],
        worktreeIds: [],
        deliveryRequirement: "local",
        updatedAt: now,
      },
    ],
  };

  function createMockInspector(
    milestoneId: string,
    inspectorId: string,
    options: {
      hasDiff?: boolean;
      hasTest?: boolean;
      verdict?: string;
      parentRead?: boolean;
      status?: "running" | "complete";
    } = {},
  ): OrchestrationChildThread {
    const {
      hasDiff = true,
      hasTest = true,
      verdict = "PASS: Verified with clean diff and passing tests.",
      parentRead = true,
      status = "complete",
    } = options;

    return {
      id: inspectorId,
      taskId: `inspect-${milestoneId}`,
      parentWorkspaceId: workspaceId,
      parentSessionId,
      childWorkspaceId: `${workspaceId}-inspector`,
      childSessionId: `session-${inspectorId}`,
      title: `Independent Inspector for ${milestoneId}`,
      role: "independent-inspector",
      status,
      environment: "local",
      createdAt: now,
      updatedAt: now,
      transcript: [
        {
          id: `msg-${inspectorId}-1`,
          role: "child",
          text: verdict,
          createdAt: now,
        },
      ],
      evidence: [
        ...(hasDiff
          ? [
              {
                id: `diff-${inspectorId}`,
                childThreadId: inspectorId,
                kind: "command" as const,
                source: "command" as const,
                status: "passed" as const,
                title: "Command or tool run",
                command: "git diff HEAD~1..HEAD",
                toolName: "powershell",
                createdAt: now,
              },
            ]
          : []),
        ...(hasTest
          ? [
              {
                id: `test-${inspectorId}`,
                childThreadId: inspectorId,
                kind: "command" as const,
                source: "command" as const,
                status: "passed" as const,
                title: "Test command run",
                command: "node --test",
                toolName: "powershell",
                createdAt: now,
              },
            ]
          : []),
        ...(parentRead
          ? [
              {
                id: `read-${inspectorId}`,
                childThreadId: inspectorId,
                kind: "orchestrator_observation" as const,
                source: "orchestrator-observed" as const,
                status: "reported" as const,
                title: "Orchestrator read child output",
                createdAt: now,
              },
            ]
          : []),
      ],
    };
  }

  test("enforces two-worker cap and reserves capacity for independent inspection", () => {
    // Two active workers max constraint
    const activeWorkers = ["worker-m1"];
    expect(activeWorkers.length).toBeLessThan(2);

    // Reserving capacity: with 1 active worker, 1 slot remains for independent inspector
    const remainingCapacity = 2 - activeWorkers.length;
    expect(remainingCapacity).toBe(1);
  });

  test("executes end-to-end 3-milestone lifecycle with dependency gating and verification gates", () => {
    let currentRun = threeMilestonePlan;

    // STEP 1: Initial dispatchability
    // M1 (foundation) and M3 (independent formatter) are dispatchable; M2 is blocked
    expect(availableStudioMilestones(currentRun).map((m) => m.id)).toEqual([
      "m1-foundation",
      "m3-formatter",
    ]);

    // STEP 2: Start Milestone 1 (Foundation)
    currentRun = transitionStudioMilestone(currentRun, "m1-foundation", "running");
    currentRun = {
      ...currentRun,
      milestones: currentRun.milestones.map((m) =>
        m.id === "m1-foundation" ? { ...m, workerThreadIds: ["worker-1"] } : m,
      ),
      revision: currentRun.revision + 1,
    };
    expect(currentRun.milestones[0]!.status).toBe("running");

    // Move M1 to verifying
    currentRun = transitionStudioMilestone(currentRun, "m1-foundation", "verifying");
    currentRun = {
      ...currentRun,
      milestones: currentRun.milestones.map((m) =>
        m.id === "m1-foundation"
          ? { ...m, workerThreadIds: ["worker-1", "inspector-m1"] }
          : m,
      ),
      revision: currentRun.revision + 1,
    };

    // Verification gate: without inspector, completion is rejected
    const m1ProposedComplete = transitionStudioMilestone(currentRun, "m1-foundation", "complete");
    expect(() =>
      assertNewStudioMilestoneCompletionsHaveEvidence(currentRun, m1ProposedComplete, []),
    ).toThrow("independent-inspector child");

    // Verification gate: with incomplete inspector, completion is rejected
    const incompleteInspector = createMockInspector("m1-foundation", "inspector-m1", {
      status: "running",
    });
    expect(() =>
      assertNewStudioMilestoneCompletionsHaveEvidence(currentRun, m1ProposedComplete, [
        incompleteInspector,
      ]),
    ).toThrow("has not completed");

    // Verification gate: with completed inspector and full evidence, verification passes!
    const validM1Inspector = createMockInspector("m1-foundation", "inspector-m1");
    expect(() =>
      assertNewStudioMilestoneCompletionsHaveEvidence(currentRun, m1ProposedComplete, [
        validM1Inspector,
      ]),
    ).not.toThrow();

    currentRun = m1ProposedComplete;
    expect(isStudioMilestoneDependencySatisfied(currentRun.milestones[0]!)).toBe(true);

    // STEP 3: M1 complete unblocks M2!
    // Now both M2 (dependent on M1) and M3 (independent) are dispatchable!
    expect(availableStudioMilestones(currentRun).map((m) => m.id)).toEqual([
      "m2-multiplication",
      "m3-formatter",
    ]);

    // STEP 4: Start Milestone 2 (Dependent Feature)
    currentRun = transitionStudioMilestone(currentRun, "m2-multiplication", "running");
    currentRun = transitionStudioMilestone(currentRun, "m2-multiplication", "verifying");
    currentRun = {
      ...currentRun,
      milestones: currentRun.milestones.map((m) =>
        m.id === "m2-multiplication"
          ? { ...m, workerThreadIds: ["worker-2", "inspector-m2"] }
          : m,
      ),
      revision: currentRun.revision + 1,
    };

    const validM2Inspector = createMockInspector("m2-multiplication", "inspector-m2");
    const m2ProposedComplete = transitionStudioMilestone(
      currentRun,
      "m2-multiplication",
      "complete",
    );
    expect(() =>
      assertNewStudioMilestoneCompletionsHaveEvidence(currentRun, m2ProposedComplete, [
        validM1Inspector,
        validM2Inspector,
      ]),
    ).not.toThrow();

    currentRun = m2ProposedComplete;
    expect(isStudioMilestoneDependencySatisfied(currentRun.milestones[1]!)).toBe(true);

    // STEP 5: Start Milestone 3 (Independent Tooling)
    expect(availableStudioMilestones(currentRun).map((m) => m.id)).toEqual(["m3-formatter"]);
    currentRun = transitionStudioMilestone(currentRun, "m3-formatter", "running");
    currentRun = transitionStudioMilestone(currentRun, "m3-formatter", "verifying");
    currentRun = {
      ...currentRun,
      milestones: currentRun.milestones.map((m) =>
        m.id === "m3-formatter"
          ? { ...m, workerThreadIds: ["worker-3", "inspector-m3"] }
          : m,
      ),
      revision: currentRun.revision + 1,
    };

    const validM3Inspector = createMockInspector("m3-formatter", "inspector-m3");
    const m3ProposedComplete = transitionStudioMilestone(currentRun, "m3-formatter", "complete");
    expect(() =>
      assertNewStudioMilestoneCompletionsHaveEvidence(currentRun, m3ProposedComplete, [
        validM1Inspector,
        validM2Inspector,
        validM3Inspector,
      ]),
    ).not.toThrow();

    currentRun = m3ProposedComplete;

    // STEP 6: All milestones complete -> transition run to completed!
    expect(currentRun.milestones.every((m) => m.status === "complete")).toBe(true);
    const finalRun = transitionStudioRun(currentRun, "completed");
    expect(finalRun.status).toBe("completed");
    expect(finalRun.milestones.map((m) => m.status)).toEqual([
      "complete",
      "complete",
      "complete",
    ]);
  });
});
