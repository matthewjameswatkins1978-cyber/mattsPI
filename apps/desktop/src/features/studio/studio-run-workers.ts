import type { OrchestrationChildThread } from "../../../contracts/desktop-state";
import type { StudioMilestone, StudioRun } from "../../../contracts/studio-runs";
import {
  resolveStudioWorkerPresence,
  type StudioWorkerPresence,
} from "../../../contracts/studio-recovery";

export interface StudioRunWorkerRow {
  readonly workerId: string;
  readonly child?: OrchestrationChildThread;
  readonly presence: StudioWorkerPresence;
}

/** Live worker ids for presence resolution: terminal child records count as history, not liveness. */
function liveChildrenOf(
  children: readonly OrchestrationChildThread[],
): readonly OrchestrationChildThread[] {
  return children.filter(
    (child) => child.status === "queued" || child.status === "running" || child.status === "waiting",
  );
}

/** Resolve only child records owned by this run's coordinator; never infer missing route data. */
export function studioRunWorkerRows(
  run: StudioRun,
  milestone: StudioMilestone,
  children: readonly OrchestrationChildThread[],
): readonly StudioRunWorkerRow[] {
  const live = liveChildrenOf(children);
  // Durable history is scoped to this run's coordinator: a same-named worker id
  // owned by another coordinator is not this run's history.
  const owned = children.filter(
    (entry) =>
      entry.parentWorkspaceId === run.workspaceId &&
      entry.parentSessionId === run.coordinatorSessionId,
  );
  const known = new Set(
    owned.flatMap((entry) => [entry.id, entry.childSessionId, entry.taskId].filter(Boolean) as string[]),
  );
  const terminalWork = milestone.status === "complete" || milestone.status === "cancelled" ||
    run.status === "completed" || run.status === "stopped";
  return milestone.workerThreadIds.map((workerId) => {
    const child = children.find(
      (entry) =>
        entry.parentWorkspaceId === run.workspaceId &&
        entry.parentSessionId === run.coordinatorSessionId &&
        (entry.id === workerId || entry.childSessionId === workerId || entry.taskId === workerId),
    );
    const presence = child
      ? resolveStudioWorkerPresence(run, milestone, workerId, live, known)
      : terminalWork
        ? "historical"
        : known.has(workerId)
          ? "missing-active"
          : "unknown-legacy";
    return { workerId, child, presence };
  });
}
