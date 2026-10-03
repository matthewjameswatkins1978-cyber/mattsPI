/**
 * Deterministic host-side restart reconciliation for Matthew Way Studio.
 *
 * Separates durable intent/history (the saved run) from current observation
 * (live worker liveness, GitHub checkpoint evidence) and derives actionability.
 * The derived disposition is never persisted and never set by model narration.
 */
import {
  hasTrustedGitHubMergeForCheckpoint,
  hasTrustedLucyAcceptForCheckpoint,
  studioExternalReviewStatus,
  transitionStudioRun,
  type StudioMilestone,
  type StudioRun,
} from "./studio-runs";

export type StudioRecoveryDisposition =
  | "active"
  | "awaiting-review"
  | "awaiting-merge"
  | "repair-needed"
  | "settled"
  | "recovery-required"
  | "historical";

export type StudioWorkerPresence = "live" | "historical" | "missing-active" | "unknown-legacy";

/** Minimal structural view of a child record; avoids a contracts cycle. */
export interface StudioRecoveryChild {
  readonly id: string;
  readonly taskId?: string;
  readonly childSessionId?: string;
  readonly parentWorkspaceId: string;
  readonly parentSessionId: string;
  readonly status: string;
}

export const STUDIO_RESTART_RECOVERY_NOTE =
  "Restart recovery required: reconcile the current Pi coordinator and worker threads, repository state, verification results, and GitHub checkpoints before dispatching more work. Preserve completed work and do not duplicate milestones already running or complete.";

const LIVE_CHILD_STATUSES: readonly string[] = ["queued", "running", "waiting"];

function childMatchesWorker(child: StudioRecoveryChild, run: StudioRun, workerId: string): boolean {
  return (
    child.parentWorkspaceId === run.workspaceId &&
    child.parentSessionId === (run.coordinatorSessionId ?? child.parentSessionId) &&
    (child.id === workerId || child.childSessionId === workerId || child.taskId === workerId)
  );
}

function isLiveChild(child: StudioRecoveryChild): boolean {
  return LIVE_CHILD_STATUSES.includes(child.status);
}

function isTerminalMilestone(milestone: StudioMilestone): boolean {
  return milestone.status === "complete" || milestone.status === "cancelled";
}

function isTerminalRun(run: StudioRun): boolean {
  return run.status === "completed" || run.status === "stopped";
}

function isOpenMilestone(milestone: StudioMilestone): boolean {
  return !isTerminalMilestone(milestone);
}

/** Resolve one persisted worker id against live children and durable history. */
export function resolveStudioWorkerPresence(
  run: StudioRun,
  milestone: StudioMilestone,
  workerId: string,
  liveChildren: readonly StudioRecoveryChild[],
  knownWorkerIds: ReadonlySet<string>,
): StudioWorkerPresence {
  const match = liveChildren.find((child) => childMatchesWorker(child, run, workerId));
  if (match && isLiveChild(match)) return "live";
  if (isTerminalMilestone(milestone) || isTerminalRun(run)) return "historical";
  if (knownWorkerIds.has(workerId)) return "missing-active";
  return "unknown-legacy";
}

/** Human wording for a worker row; historical work is normal, missing work is a signal. */
export function studioWorkerPresenceLabel(
  presence: StudioWorkerPresence,
  workerId: string,
): string {
  switch (presence) {
    case "live":
      return workerId;
    case "historical":
      return `Historical worker · session no longer active · ${workerId}`;
    case "missing-active":
      return `Worker session unavailable · reconciliation required · ${workerId}`;
    case "unknown-legacy":
      return `Worker session unavailable · reconciliation required · ${workerId}`;
  }
}

/** Derive one milestone's recovery disposition from durable evidence plus liveness. */
export function deriveStudioMilestoneRecovery(
  milestone: StudioMilestone,
  hasLiveWorker: boolean,
): StudioRecoveryDisposition {
  const checkpoints = milestone.githubCheckpoints ?? [];
  const latest = checkpoints.at(-1);

  if (latest) {
    const merged = hasTrustedGitHubMergeForCheckpoint(latest);
    const accepted = hasTrustedLucyAcceptForCheckpoint(latest);
    if (merged && accepted) return "settled";
    if (merged && !accepted) return "historical";
    if (accepted) return "awaiting-merge";
    const latestReview = [...latest.reviewHistory]
      .reverse()
      .find(({ source }) => source === "matthew-confirmed-lucy");
    if (latestReview?.decision === "changes-requested") return "repair-needed";
    // A newer pushed HEAD wipes prior review meaning: never transfer conclusions.
    if (latest.reviewHistory.length === 0 && checkpoints.length > 1) return "recovery-required";
    if (isTerminalMilestone(milestone)) return "settled";
    if (milestone.status === "verifying") {
      try {
        const status = studioExternalReviewStatus(milestone, latest.headSha);
        if (status === "awaiting-lucy") return "awaiting-review";
        if (status === "accepted") return "awaiting-merge";
        if (status === "changes-requested") return "repair-needed";
        if (status === "superseded") return "recovery-required";
      } catch {
        return "recovery-required";
      }
    }
    if (milestone.status === "repair-needed" || milestone.status === "blocked") {
      return "repair-needed";
    }
    if (isOpenMilestone(milestone)) {
      if (hasLiveWorker) return "active";
      // An open PR checkpoint with no live worker is waiting for review, not resumable work.
      return "awaiting-review";
    }
    return "settled";
  }

  if (isTerminalMilestone(milestone)) return "settled";
  if (milestone.status === "repair-needed" || milestone.status === "blocked")
    return "repair-needed";
  if (isOpenMilestone(milestone)) return hasLiveWorker ? "active" : "recovery-required";
  return "recovery-required";
}

export interface StudioRunRecovery {
  readonly disposition: StudioRecoveryDisposition;
  readonly summary: string;
  readonly canResumeImplementation: boolean;
  readonly inHistory: boolean;
}

function milestoneHeadShort(milestone: StudioMilestone): string | undefined {
  const head = milestone.githubCheckpoints?.at(-1)?.headSha;
  return head?.slice(0, 7);
}

/** Derive run-level actionability from per-milestone dispositions. */
export function deriveStudioRunRecovery(
  run: StudioRun,
  liveChildren: readonly StudioRecoveryChild[],
  knownWorkerIds: ReadonlySet<string> = new Set(),
): StudioRunRecovery {
  if (run.status === "completed") {
    return {
      disposition: "settled",
      summary: "Completed",
      canResumeImplementation: false,
      inHistory: true,
    };
  }
  if (run.status === "stopped") {
    return {
      disposition: "historical",
      summary: "Stopped · history preserved",
      canResumeImplementation: false,
      inHistory: true,
    };
  }

  const liveForMilestone = (milestone: StudioMilestone): boolean =>
    milestone.workerThreadIds.some(
      (workerId) =>
        resolveStudioWorkerPresence(run, milestone, workerId, liveChildren, knownWorkerIds) ===
        "live",
    );
  const dispositions = run.milestones.map((milestone) =>
    deriveStudioMilestoneRecovery(milestone, liveForMilestone(milestone)),
  );

  const pick: StudioRecoveryDisposition = dispositions.includes("repair-needed")
    ? "repair-needed"
    : dispositions.includes("recovery-required")
      ? "recovery-required"
      : dispositions.includes("active")
        ? "active"
        : dispositions.includes("awaiting-review")
          ? "awaiting-review"
          : dispositions.includes("awaiting-merge")
            ? "awaiting-merge"
            : dispositions.every((entry) => entry === "settled")
              ? "settled"
              : "historical";

  const head = run.milestones.map((milestone) => milestoneHeadShort(milestone)).find(Boolean);
  const headSuffix = head ? ` · HEAD ${head}` : "";
  switch (pick) {
    case "active":
      return {
        disposition: pick,
        summary: "Active",
        canResumeImplementation: false,
        inHistory: false,
      };
    case "awaiting-review":
      return {
        disposition: pick,
        summary: `Awaiting Matthew review${headSuffix}`,
        canResumeImplementation: false,
        inHistory: false,
      };
    case "awaiting-merge":
      return {
        disposition: pick,
        summary: `Awaiting merge · Matthew accepted${headSuffix}`,
        canResumeImplementation: false,
        inHistory: false,
      };
    case "repair-needed":
      return {
        disposition: pick,
        summary: `Changes requested${headSuffix}`,
        canResumeImplementation: true,
        inHistory: false,
      };
    case "settled":
      return {
        disposition: pick,
        summary: head ? `Completed · PR merged at ${head}` : "Completed",
        canResumeImplementation: false,
        inHistory: true,
      };
    case "historical":
      return {
        disposition: pick,
        summary: "Historical · merged externally; Studio acceptance record was not completed",
        canResumeImplementation: false,
        inHistory: true,
      };
    case "recovery-required":
      return {
        disposition: pick,
        summary: "Recovery required · worker missing and no durable delivery checkpoint",
        canResumeImplementation: true,
        inHistory: false,
      };
  }
}

export interface StudioRestartReconcileContext {
  readonly liveChildren: readonly StudioRecoveryChild[];
  readonly knownWorkerIds: ReadonlySet<string>;
}

function runHasLiveWork(run: StudioRun, context: StudioRestartReconcileContext): boolean {
  return run.milestones
    .filter((milestone) => isOpenMilestone(milestone))
    .some((milestone) =>
      milestone.workerThreadIds.some(
        (workerId) =>
          resolveStudioWorkerPresence(
            run,
            milestone,
            workerId,
            context.liveChildren,
            context.knownWorkerIds,
          ) === "live",
      ),
    );
}

function withRecoveryNote(run: StudioRun, now: string): StudioRun {
  if (run.lastError?.includes(STUDIO_RESTART_RECOVERY_NOTE)) return run;
  const paused = run.status === "running" ? transitionStudioRun(run, "paused", now) : run;
  const lastError = run.lastError?.trim()
    ? `${run.lastError.trim()}\n\n${STUDIO_RESTART_RECOVERY_NOTE}`
    : STUDIO_RESTART_RECOVERY_NOTE;
  if (paused === run && lastError === run.lastError) return run;
  if (paused !== run) return { ...paused, lastError };
  return {
    ...run,
    lastError,
    updatedAt: now,
    revision: run.revision + 1,
  };
}

/**
 * Idempotent host-side restart reconciliation. Observation first: never dispatches
 * workers, never rewrites checkpoints, never fabricates acceptance. Repeated calls
 * against unchanged reality return identical references with no new mutations.
 */
export function reconcileStudioRunsForRestart(
  runs: readonly StudioRun[],
  context: StudioRestartReconcileContext,
  now = new Date().toISOString(),
): readonly StudioRun[] {
  let changed = false;
  const reconciled = runs.map((run) => {
    if (isTerminalRun(run)) return run;
    if (run.status !== "running") {
      // Paused/draft/blocked runs keep durable history untouched; the derived
      // disposition (not persisted) decides actionability at render time.
      return run;
    }
    if (runHasLiveWork(run, context)) return run;
    changed = true;
    return withRecoveryNote(run, now);
  });
  return changed ? reconciled : runs;
}
