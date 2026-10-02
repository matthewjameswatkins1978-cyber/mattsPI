import type { OrchestrationChildThread } from "../../../contracts/desktop-state";
import type { StudioMilestone, StudioRun } from "../../../contracts/studio-runs";

export interface StudioRunWorkerRow {
  readonly workerId: string;
  readonly child?: OrchestrationChildThread;
}

/** Resolve only child records owned by this run's coordinator; never infer missing route data. */
export function studioRunWorkerRows(
  run: StudioRun,
  milestone: StudioMilestone,
  children: readonly OrchestrationChildThread[],
): readonly StudioRunWorkerRow[] {
  return milestone.workerThreadIds.map((workerId) => ({
    workerId,
    child: children.find(
      (child) =>
        child.parentWorkspaceId === run.workspaceId &&
        child.parentSessionId === run.coordinatorSessionId &&
        (child.id === workerId || child.childSessionId === workerId || child.taskId === workerId),
    ),
  }));
}
