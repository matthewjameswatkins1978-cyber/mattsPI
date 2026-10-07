import { expect, test } from "@playwright/test";
import {
  deriveStudioMilestoneRecovery,
  deriveStudioRunRecovery,
  reconcileStudioRunsForRestart,
  resolveLiveStudioRecoveryChildren,
  resolveStudioWorkerPresence,
  studioWorkerPresenceLabel,
  type StudioRecoveryChild,
} from "../../contracts/studio-recovery";
import {
  applyStudioGitHubPullRequestObservation,
  recordStudioGitHubCheckpoint,
  recordStudioGitHubMerge,
  recordStudioGitHubReview,
  type StudioMilestone,
  type StudioRun,
} from "../../contracts/studio-runs";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const HEAD2 = "c".repeat(40);
const MERGE = "d".repeat(40);

function milestone(overrides: Partial<StudioMilestone> = {}): StudioMilestone {
  return {
    id: "m1",
    title: "Milestone",
    instruction: "Do bounded work.",
    dependsOn: [],
    status: "queued",
    workerThreadIds: [],
    worktreeIds: [],
    deliveryRequirement: "github-pr",
    updatedAt: "2026-09-29T00:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<StudioRun> = {}): StudioRun {
  return {
    id: "run-1",
    workspaceId: "workspace-1",
    repositoryPath: "C:\\scratch\\repo",
    coordinatorSessionId: "coordinator-1",
    specification: "Implement a bounded change.",
    mode: "observed",
    status: "paused",
    milestones: [milestone()],
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

function child(overrides: Partial<StudioRecoveryChild> = {}): StudioRecoveryChild {
  return {
    id: "worker-1",
    taskId: "task-1",
    childWorkspaceId: "workspace-1",
    childSessionId: "session-1",
    parentWorkspaceId: "workspace-1",
    parentSessionId: "coordinator-1",
    status: "running",
    ...overrides,
  };
}

function checkpointed(status: StudioMilestone["status"] = "verifying"): StudioMilestone {
  return recordStudioGitHubCheckpoint(milestone({ status, workerThreadIds: [] }), {
    repository: "owner/repo",
    branch: "studio/m1",
    pullRequestUrl: "https://github.com/owner/repo/pull/12",
    baseSha: BASE,
    headSha: HEAD,
    pushedAt: "2026-09-29T00:00:00.000Z",
  });
}

test.describe("Studio restart reconciliation", () => {
  test("saved running with a live worker stays active without mutation", () => {
    const ms = milestone({ status: "running", workerThreadIds: ["worker-1"] });
    const target = run({ status: "running", milestones: [ms] });
    const live = [child({})];
    expect(deriveStudioRunRecovery(target, live, new Set(["worker-1"])).disposition).toBe("active");
    const reconciled = reconcileStudioRunsForRestart(
      [target],
      { liveChildren: live, knownWorkerIds: new Set(["worker-1"]) },
      "2026-09-29T01:00:00.000Z",
    );
    expect(reconciled[0]).toBe(target);
  });

  test("saved running with no worker and no evidence becomes recovery-required", () => {
    const ms = milestone({ status: "running", workerThreadIds: ["worker-1"] });
    const target = run({ status: "running", milestones: [ms] });
    const recovery = deriveStudioRunRecovery(target, [], new Set(["worker-1"]));
    expect(recovery.disposition).toBe("recovery-required");
    expect(recovery.canResumeImplementation).toBe(true);
    const reconciled = reconcileStudioRunsForRestart(
      [target],
      { liveChildren: [], knownWorkerIds: new Set(["worker-1"]) },
      "2026-09-29T01:00:00.000Z",
    );
    expect(reconciled[0]).toMatchObject({ status: "paused" });
    expect(reconciled[0]?.lastError).toContain("Restart recovery required");
    // Second restart with unchanged truth produces no new mutation.
    expect(
      reconcileStudioRunsForRestart(
        reconciled,
        { liveChildren: [], knownWorkerIds: new Set(["worker-1"]) },
        "2026-09-29T02:00:00.000Z",
      ),
    ).toBe(reconciled);
  });

  test("latest same-SHA changes-requested overrides an earlier ACCEPT", () => {
    let ms = checkpointed("verifying");
    ms = recordStudioGitHubReview(ms, {
      headSha: HEAD,
      decision: "accepted",
      now: "2026-09-29T01:00:00.000Z",
    });
    ms = recordStudioGitHubReview(ms, {
      headSha: HEAD,
      decision: "changes-requested",
      now: "2026-09-29T02:00:00.000Z",
    });

    expect(deriveStudioMilestoneRecovery(ms, false)).toBe("repair-needed");
    expect(
      deriveStudioRunRecovery(run({ milestones: [ms] }), [], new Set()).canResumeImplementation,
    ).toBe(true);
  });

  test("latest same-SHA ACCEPT overrides an earlier changes-requested", () => {
    let ms = checkpointed("verifying");
    ms = recordStudioGitHubReview(ms, {
      headSha: HEAD,
      decision: "changes-requested",
      now: "2026-09-29T01:00:00.000Z",
    });
    ms = recordStudioGitHubReview(ms, {
      headSha: HEAD,
      decision: "accepted",
      now: "2026-09-29T02:00:00.000Z",
    });

    expect(deriveStudioMilestoneRecovery(ms, false)).toBe("awaiting-merge");
    expect(
      deriveStudioRunRecovery(run({ milestones: [ms] }), [], new Set()).canResumeImplementation,
    ).toBe(false);
  });
  test("verifying with an exact open PR awaits review, not implementation", () => {
    const ms = checkpointed("verifying");
    const recovery = deriveStudioRunRecovery(run({ milestones: [ms] }), [], new Set());
    expect(recovery.disposition).toBe("awaiting-review");
    expect(recovery.canResumeImplementation).toBe(false);
    expect(deriveStudioMilestoneRecovery(ms, false)).toBe("awaiting-review");
  });

  test("verifying with exact merge plus trusted ACCEPT settles", () => {
    let ms = checkpointed("verifying");
    ms = recordStudioGitHubReview(ms, { headSha: HEAD, decision: "accepted" });
    ms = recordStudioGitHubMerge(ms, {
      headSha: HEAD,
      mergeCommitSha: MERGE,
      mergedAt: "2026-09-29T02:00:00.000Z",
      observedAt: "2026-09-29T02:00:00.000Z",
    });
    const recovery = deriveStudioRunRecovery(run({ milestones: [ms] }), [], new Set());
    expect(recovery.disposition).toBe("settled");
    expect(recovery.canResumeImplementation).toBe(false);
  });

  test("merge without trusted ACCEPT never fabricates acceptance", () => {
    let ms = checkpointed("verifying");
    ms = recordStudioGitHubMerge(ms, {
      headSha: HEAD,
      mergeCommitSha: MERGE,
      mergedAt: "2026-09-29T02:00:00.000Z",
      observedAt: "2026-09-29T02:00:00.000Z",
    });
    const recovery = deriveStudioRunRecovery(run({ milestones: [ms] }), [], new Set());
    expect(recovery.disposition).toBe("historical");
    expect(recovery.canResumeImplementation).toBe(false);
    expect(recovery.summary).toContain("acceptance record was not completed");
  });

  test("accepted open PR awaits merge with no implementation worker", () => {
    let ms = checkpointed("verifying");
    ms = recordStudioGitHubReview(ms, { headSha: HEAD, decision: "accepted" });
    const recovery = deriveStudioRunRecovery(run({ milestones: [ms] }), [], new Set());
    expect(recovery.disposition).toBe("awaiting-merge");
    expect(recovery.canResumeImplementation).toBe(false);
  });

  test("changes requested needs repair with resume allowed", () => {
    let ms = checkpointed("verifying");
    ms = recordStudioGitHubReview(ms, { headSha: HEAD, decision: "changes-requested" });
    const recovery = deriveStudioRunRecovery(run({ milestones: [ms] }), [], new Set());
    expect(recovery.disposition).toBe("repair-needed");
    expect(recovery.canResumeImplementation).toBe(true);
  });

  test("a newer pushed HEAD never inherits the previous review", () => {
    let ms = checkpointed("verifying");
    ms = recordStudioGitHubReview(ms, { headSha: HEAD, decision: "accepted" });
    ms = recordStudioGitHubCheckpoint(ms, {
      repository: "owner/repo",
      branch: "studio/m1",
      pullRequestUrl: "https://github.com/owner/repo/pull/12",
      baseSha: BASE,
      headSha: HEAD2,
      pushedAt: "2026-09-29T03:00:00.000Z",
    });
    expect(deriveStudioMilestoneRecovery(ms, false)).toBe("recovery-required");
  });

  test("terminal runs are unchanged by reconciliation", () => {
    const completed = run({ status: "completed" });
    const stopped = run({ status: "stopped" });
    const reconciled = reconcileStudioRunsForRestart([completed, stopped], {
      liveChildren: [],
      knownWorkerIds: new Set(),
    });
    expect(reconciled[0]).toBe(completed);
    expect(reconciled[1]).toBe(stopped);
    expect(deriveStudioRunRecovery(completed, [], new Set()).disposition).toBe("settled");
    expect(deriveStudioRunRecovery(stopped, [], new Set()).disposition).toBe("historical");
  });

  test("restart uses current session status, not persisted worker status, for liveness", () => {
    const targetMilestone = milestone({ status: "running", workerThreadIds: ["worker-1"] });
    const targetRun = run({ status: "running", milestones: [targetMilestone] });
    const savedWorker = child({ status: "running" });
    const knownWorkerIds = new Set(["worker-1"]);

    const absentSession = resolveLiveStudioRecoveryChildren([savedWorker], []);
    expect(absentSession).toEqual([]);
    expect(
      deriveStudioRunRecovery(targetRun, absentSession, knownWorkerIds).canResumeImplementation,
    ).toBe(true);
    expect(
      reconcileStudioRunsForRestart(
        [targetRun],
        { liveChildren: absentSession, knownWorkerIds },
        "2026-09-29T01:00:00.000Z",
      )[0],
    ).toMatchObject({ status: "paused" });

    const currentSession = resolveLiveStudioRecoveryChildren(
      [savedWorker],
      [{ workspaceId: "workspace-1", sessionId: "session-1", status: "running" }],
    );
    expect(currentSession).toMatchObject([{ id: "worker-1", status: "running" }]);
    expect(deriveStudioRunRecovery(targetRun, currentSession, knownWorkerIds).disposition).toBe(
      "active",
    );
    expect(
      reconcileStudioRunsForRestart(
        [targetRun],
        { liveChildren: currentSession, knownWorkerIds },
        "2026-09-29T01:00:00.000Z",
      )[0],
    ).toBe(targetRun);
  });
  test("worker presence distinguishes history from genuinely missing work", () => {
    const open = milestone({ status: "running", workerThreadIds: ["worker-1"] });
    const openRun = run({ status: "paused", milestones: [open] });
    expect(
      resolveStudioWorkerPresence(openRun, open, "worker-1", [child({})], new Set(["worker-1"])),
    ).toBe("live");
    expect(resolveStudioWorkerPresence(openRun, open, "worker-1", [], new Set(["worker-1"]))).toBe(
      "missing-active",
    );
    expect(resolveStudioWorkerPresence(openRun, open, "legacy-id", [], new Set())).toBe(
      "unknown-legacy",
    );
    const done = milestone({ status: "complete", workerThreadIds: ["worker-1"] });
    const doneRun = run({ status: "paused", milestones: [done] });
    expect(resolveStudioWorkerPresence(doneRun, done, "worker-1", [], new Set())).toBe(
      "historical",
    );
    expect(studioWorkerPresenceLabel("historical", "worker-1")).toContain("Historical worker");
    expect(studioWorkerPresenceLabel("missing-active", "worker-1")).toContain(
      "reconciliation required",
    );
    expect(studioWorkerPresenceLabel("missing-active", "worker-1")).not.toContain(
      "details not loaded",
    );
  });

  test("W2 regression: merged PR at recorded HEAD is history, never resumable", () => {
    let merged = checkpointed("verifying");
    merged = recordStudioGitHubMerge(merged, {
      headSha: HEAD,
      mergeCommitSha: MERGE,
      mergedAt: "2026-09-29T02:00:00.000Z",
      observedAt: "2026-09-29T02:00:00.000Z",
    });
    // The real stale card: the run still claims open work, the saved workers are
    // gone, but the exact recorded HEAD is already merged on GitHub. With no
    // trusted Matthew acceptance on record this must read as merged-externally
    // history: inspectable, never a Resume-implementation card.
    const done = milestone({ id: "m2", title: "Follow-up", status: "complete" });
    const w2 = run({
      status: "paused",
      milestones: [
        { ...merged, workerThreadIds: ["gone-worker-1"] },
        { ...done, workerThreadIds: ["gone-worker-2"] },
      ],
    });
    expect(deriveStudioMilestoneRecovery(w2.milestones[0]!, false)).toBe("historical");
    expect(deriveStudioMilestoneRecovery(w2.milestones[1]!, false)).toBe("settled");
    const recovery = deriveStudioRunRecovery(w2, [], new Set(["gone-worker-1"]));
    expect(recovery.disposition).toBe("historical");
    expect(recovery.canResumeImplementation).toBe(false);
    // No worker is dispatched by reconciliation itself.
    const reconciled = reconcileStudioRunsForRestart([w2], {
      liveChildren: [],
      knownWorkerIds: new Set(["gone-worker-1"]),
    });
    expect(reconciled[0]).toBe(w2);
  });

  test("a fresh draft without workers or checkpoints is startable, not missing", () => {
    const target = run({
      status: "draft",
      milestones: [milestone({ status: "queued", workerThreadIds: [] })],
    });
    const recovery = deriveStudioRunRecovery(target, [], new Set());
    expect(recovery.disposition).toBe("recovery-required");
    expect(recovery.summary).toBe("Draft plan · not yet started");
    expect(recovery.canResumeImplementation).toBe(true);
    expect(recovery.inHistory).toBe(false);
  });

  test("a running run whose milestones all finished closes instead of recovering", () => {
    const target = run({
      status: "running",
      milestones: [
        milestone({ id: "m1", status: "complete", workerThreadIds: ["gone"] }),
        milestone({ id: "m2", status: "cancelled", workerThreadIds: [] }),
      ],
    });
    const reconciled = reconcileStudioRunsForRestart(
      [target],
      { liveChildren: [], knownWorkerIds: new Set() },
      "2026-09-29T01:00:00.000Z",
    );
    expect(reconciled[0]?.status).toBe("completed");
    expect(reconciled[0]?.lastError ?? "").not.toContain("Restart recovery required");
    expect(deriveStudioRunRecovery(reconciled[0]!, [], new Set()).disposition).toBe("settled");
    // Settled work stays settled across further restarts.
    expect(
      reconcileStudioRunsForRestart(reconciled, { liveChildren: [], knownWorkerIds: new Set() })[0],
    ).toBe(reconciled[0]);
  });

  test("restart pipeline: reconcile, observe merge, derive, repeat without mutation", () => {
    const observedAt = "2026-09-29T02:00:00.000Z";
    const ms = checkpointed("verifying");
    const target = run({ status: "running", milestones: [{ ...ms, workerThreadIds: ["gone"] }] });
    const context = { liveChildren: [], knownWorkerIds: new Set<string>() };
    // 1. Restart pauses the workerless run exactly once.
    const afterRestart = reconcileStudioRunsForRestart([target], context, observedAt);
    expect(afterRestart[0]?.status).toBe("paused");
    // 2. A read-only GitHub observation lands on the exact checkpoint SHA.
    const observed = applyStudioGitHubPullRequestObservation(afterRestart[0]!.milestones[0]!, {
      repository: "owner/repo",
      branch: "studio/m1",
      pullRequestUrl: "https://github.com/owner/repo/pull/12",
      baseSha: BASE,
      headSha: HEAD,
      observedAt,
      merged: true,
      mergeCommitSha: MERGE,
      mergedAt: observedAt,
    });
    // 3. Merge alone is not acceptance: historical, non-dispatchable.
    const withObservation = { ...afterRestart[0]!, milestones: [observed] };
    const recovery = deriveStudioRunRecovery(withObservation, [], new Set());
    expect(recovery.disposition).toBe("historical");
    expect(recovery.canResumeImplementation).toBe(false);
    // 4. Repeating the observation and the restart changes nothing further.
    expect(
      applyStudioGitHubPullRequestObservation(observed, {
        repository: "owner/repo",
        branch: "studio/m1",
        pullRequestUrl: "https://github.com/owner/repo/pull/12",
        baseSha: BASE,
        headSha: HEAD,
        observedAt,
        merged: true,
        mergeCommitSha: MERGE,
        mergedAt: observedAt,
      }),
    ).toBe(observed);
    expect(reconcileStudioRunsForRestart([withObservation], context, observedAt)[0]).toBe(
      withObservation,
    );
  });
});
