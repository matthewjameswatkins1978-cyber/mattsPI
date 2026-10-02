import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { StudioRun, StudioRunDeliveryPolicy } from "../../../contracts/studio-runs";
import {
  hasTrustedGitHubMergeForCheckpoint,
  studioExternalReviewStatus,
  transitionStudioRun,
} from "../../../contracts/studio-runs";
import type {
  DesktopAppState,
  OrchestrationChildThread,
  WorkspaceRecord,
  WorkspaceSessionTarget,
} from "../../../contracts/desktop-state";
import type { PiDesktopApi } from "../../../contracts/ipc";
import { studioRunWorkerRows } from "./studio-run-workers";

interface StudioRunsViewProps {
  readonly workspaces: readonly WorkspaceRecord[];
  readonly selectedWorkspaceId: string;
  readonly selectedThreadTarget?: WorkspaceSessionTarget;
  readonly runs: readonly StudioRun[];
  readonly orchestrationChildren: readonly OrchestrationChildThread[];
  readonly api: PiDesktopApi;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly updateSnapshot: (
    setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>,
    action: () => Promise<DesktopAppState>,
  ) => Promise<DesktopAppState>;
}

const stamp = () => new Date().toISOString();

function createDraftRun(
  workspace: WorkspaceRecord,
  specification: string,
  mode: StudioRun["mode"],
  deliveryPolicy: StudioRunDeliveryPolicy,
): StudioRun {
  const now = stamp();
  const runId = `studio-${crypto.randomUUID()}`;
  return {
    id: runId,
    workspaceId: workspace.id,
    repositoryPath: workspace.path,
    specification,
    mode,
    deliveryPolicy,
    status: "draft",
    milestones: [
      {
        id: `${runId}-plan`,
        title: "Plan and implement",
        instruction: specification,
        dependsOn: [],
        status: "queued",
        workerThreadIds: [],
        worktreeIds: [],
        deliveryRequirement: deliveryPolicy,
        updatedAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
    revision: 1,
  };
}

export function StudioRunsView({
  workspaces,
  selectedWorkspaceId,
  selectedThreadTarget,
  runs,
  orchestrationChildren,
  api,
  setSnapshot,
  updateSnapshot,
}: StudioRunsViewProps) {
  const [workspaceId, setWorkspaceId] = useState(selectedWorkspaceId);
  const [specification, setSpecification] = useState("");
  const [mode, setMode] = useState<StudioRun["mode"]>("observed");
  const [deliveryPolicy, setDeliveryPolicy] = useState<StudioRunDeliveryPolicy>("github-pr");
  const [busyRunId, setBusyRunId] = useState<string>();
  const [error, setError] = useState<string>();
  const [correctionText, setCorrectionText] = useState("");
  const workspace = workspaces.find((entry) => entry.id === workspaceId);
  const visibleRuns = useMemo(
    () => runs.filter((run) => run.workspaceId === workspaceId),
    [runs, workspaceId],
  );

  const save = async (run: StudioRun) => {
    setBusyRunId(run.id);
    setError(undefined);
    try {
      await updateSnapshot(setSnapshot, () => api.saveStudioRun(run));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Studio could not save that update.");
    } finally {
      setBusyRunId(undefined);
    }
  };

  const createPlan = async () => {
    if (!workspace || !specification.trim()) return;
    const run = createDraftRun(workspace, specification.trim(), mode, deliveryPolicy);
    await save(run);
    setSpecification("");
  };

  const prepareInCurrentThread = async () => {
    const packet = specification.trim();
    if (!workspace || !packet || !selectedThreadTarget) return;
    const run = {
      ...createDraftRun(workspace, packet, mode, deliveryPolicy),
      coordinatorSessionId: selectedThreadTarget.sessionId,
    };
    setBusyRunId(run.id);
    setError(undefined);
    try {
      await updateSnapshot(setSnapshot, () => api.saveStudioRun(run));
      await updateSnapshot(setSnapshot, () =>
        api.updateComposerDraft(`/studio ${packet}`, selectedThreadTarget),
      );
      await updateSnapshot(setSnapshot, () => api.setActiveView("threads"));
      setSpecification("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Studio could not prepare the packet in the selected thread.",
      );
    } finally {
      setBusyRunId(undefined);
    }
  };

  const changeStatus = (run: StudioRun, status: StudioRun["status"]) => {
    try {
      save(transitionStudioRun(run, status)).catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That status change is not allowed.");
    }
  };

  const stopRun = async (run: StudioRun) => {
    setBusyRunId(run.id);
    setError(undefined);
    try {
      await updateSnapshot(setSnapshot, () =>
        api.saveStudioRun(transitionStudioRun(run, "stopped")),
      );
      if (run.coordinatorSessionId) {
        const coordinatorTarget = {
          workspaceId: run.workspaceId,
          sessionId: run.coordinatorSessionId,
        };
        await updateSnapshot(setSnapshot, () => api.selectSession(coordinatorTarget));
        await updateSnapshot(setSnapshot, () => api.cancelCurrentRun());
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Studio stopped dispatch, but could not confirm cancellation of its active work.",
      );
    } finally {
      setBusyRunId(undefined);
    }
  };

  const startRun = async (run: StudioRun) => {
    if (
      run.mode !== "observed" ||
      !run.coordinatorSessionId ||
      selectedThreadTarget?.workspaceId !== run.workspaceId ||
      selectedThreadTarget.sessionId !== run.coordinatorSessionId
    )
      return;
    setBusyRunId(run.id);
    setError(undefined);
    try {
      await updateSnapshot(setSnapshot, () =>
        api.submitComposerToTarget("/studio start", {
          workspaceId: run.workspaceId,
          sessionId: run.coordinatorSessionId!,
        }),
      );
      await updateSnapshot(setSnapshot, () =>
        api.saveStudioRun(transitionStudioRun(run, "running")),
      );
      await updateSnapshot(setSnapshot, () => api.setActiveView("threads"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Studio could not start this run.");
    } finally {
      setBusyRunId(undefined);
    }
  };

  const prepareCorrection = async (run: StudioRun) => {
    if (!run.coordinatorSessionId || !correctionText.trim()) return;
    const coordinatorTarget = {
      workspaceId: run.workspaceId,
      sessionId: run.coordinatorSessionId,
    };
    const correctionId = `correction-${crypto.randomUUID()}`;
    const correction = {
      id: correctionId,
      instruction: correctionText,
      specificationRevision: (run.specificationRevision ?? 1) + 1,
    };
    const packet = [
      `/studio [LIVE CORRECTION for run ${run.id}; specification revision ${correction.specificationRevision}]`,
      correction.instruction,
      `Affected milestone records: ${
        run.milestones
          .filter(({ status }) => status !== "complete" && status !== "cancelled")
          .map(({ id }) => id)
          .join(", ") || "none"
      }`,
      "Reconcile the repository and affected work first. Preserve completed and independent work. Keep existing milestone records immutable; progress affected old milestones through their valid lifecycle and append replacement milestones with new IDs and the corrected dependency graph. Mark this correction sent after acting on it, then applied only after reconciliation is complete with a concise reconciliationSummary. Do not create a duplicate run.",
    ].join("\n\n");
    setBusyRunId(run.id);
    setError(undefined);
    try {
      await updateSnapshot(setSnapshot, () =>
        api.recordStudioCorrection({
          runId: run.id,
          id: correction.id,
          instruction: correction.instruction,
          affectedMilestoneIds: run.milestones
            .filter(({ status }) => status !== "complete" && status !== "cancelled")
            .map(({ id }) => id),
        }),
      );
      await updateSnapshot(setSnapshot, () => api.updateComposerDraft(packet, coordinatorTarget));
      await updateSnapshot(setSnapshot, () => api.selectSession(coordinatorTarget));
      await updateSnapshot(setSnapshot, () => api.setActiveView("threads"));
      setCorrectionText("");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Studio could not prepare that correction.",
      );
    } finally {
      setBusyRunId(undefined);
    }
  };

  const confirmLucyDecision = async (
    run: StudioRun,
    milestoneId: string,
    headSha: string,
    decision: "accepted" | "changes-requested",
  ) => {
    const decisionLabel = decision === "accepted" ? "ACCEPT" : "CHANGES REQUESTED";
    if (
      !window.confirm(
        `Confirm Lucy's ${decisionLabel} for exactly this pushed HEAD SHA?\n\n${headSha}\n\nPi will record your confirmation. It will not mark the PR merged.`,
      )
    ) {
      return;
    }
    setBusyRunId(run.id);
    setError(undefined);
    try {
      await updateSnapshot(setSnapshot, () =>
        api.confirmStudioExternalReview({
          runId: run.id,
          milestoneId,
          reviewedHeadSha: headSha,
          decision,
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Studio could not record Lucy's decision.");
    } finally {
      setBusyRunId(undefined);
    }
  };

  const refreshGitHubPullRequest = async (run: StudioRun, milestoneId: string) => {
    setBusyRunId(run.id);
    setError(undefined);
    try {
      await updateSnapshot(setSnapshot, () =>
        api.reconcileStudioGitHubPullRequest({ runId: run.id, milestoneId }),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Studio could not refresh this pull request from GitHub.",
      );
    } finally {
      setBusyRunId(undefined);
    }
  };

  return (
    <section className="canvas studio-runs-view" data-testid="studio-runs-view">
      <header className="view-header">
        <div>
          <h1 className="view-header__title">Matthew Way Studio</h1>
          <p className="view-header__body">
            Keep project plans and milestone status with the project. Recording a plan does not
            start an agent run.
          </p>
        </div>
      </header>
      <div className="studio-runs-view__content">
        <section className="studio-card" aria-labelledby="studio-new-plan-title">
          <h2 id="studio-new-plan-title">Record a project plan</h2>
          <label className="studio-field">
            <span>Project</span>
            <select
              value={workspaceId}
              onChange={(event) => setWorkspaceId(event.currentTarget.value)}
            >
              {workspaces.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>
          <label className="studio-field">
            <span>Mode</span>
            <select
              value={mode}
              onChange={(event) => setMode(event.currentTarget.value as StudioRun["mode"])}
            >
              <option value="observed">Observed</option>
              <option value="autonomous">Autonomous</option>
            </select>
          </label>
          <label className="studio-field">
            <span>Delivery</span>
            <select
              value={deliveryPolicy}
              onChange={(event) =>
                setDeliveryPolicy(event.currentTarget.value as StudioRunDeliveryPolicy)
              }
            >
              <option value="github-pr">GitHub pull request (default)</option>
              <option value="local">Local-only demonstration</option>
            </select>
          </label>
          <label className="studio-field">
            <span>Specification or implementation packet</span>
            <textarea
              rows={7}
              value={specification}
              placeholder="Paste the request or implementation packet here…"
              onChange={(event) => setSpecification(event.currentTarget.value)}
            />
          </label>
          <button
            className="button button--primary"
            type="button"
            disabled={!workspace || !specification.trim() || Boolean(busyRunId)}
            onClick={() => {
              createPlan().catch(() => undefined);
            }}
          >
            Save draft
          </button>
          <button
            className="button"
            type="button"
            disabled={
              !workspace ||
              workspace.id !== selectedThreadTarget?.workspaceId ||
              !selectedThreadTarget ||
              !specification.trim() ||
              mode !== "observed" ||
              Boolean(busyRunId)
            }
            onClick={() => {
              prepareInCurrentThread().catch(() => undefined);
            }}
          >
            Prepare in current thread
          </button>
          <p className="studio-note">
            Preparing stores the draft and fills the selected project thread with a /studio command.
            It does not send the command. Check the selected model, then send it when you are ready.
            This handoff is available in Observed mode. Delivery policy is recorded once at creation
            and is host-owned: milestones appended later inherit it. Local-only delivery is an
            authorised demonstration route; dependent milestones then unlock on internally verified
            local completion instead of an observed GitHub merge.
          </p>
        </section>

        <section className="studio-runs-list" aria-labelledby="studio-runs-title">
          <h2 id="studio-runs-title">Project runs</h2>
          {!workspace ? <p>Open a project folder to use Studio.</p> : null}
          {workspace && visibleRuns.length === 0 ? (
            <p>No plans recorded for this project yet.</p>
          ) : null}
          {visibleRuns.map((run) => (
            <article className="studio-card studio-run" data-testid="studio-run" key={run.id}>
              <div className="studio-run__heading">
                <div>
                  <h3>{run.milestones[0]?.title ?? "Project run"}</h3>
                  <p>
                    {run.mode === "observed" ? "Observed" : "Autonomous"} · {run.status}
                    {" · "}
                    {(run.deliveryPolicy ?? "github-pr") === "local"
                      ? "Local-only delivery"
                      : "GitHub PR delivery"}
                  </p>
                </div>
                <span className="studio-run__revision">Revision {run.revision}</span>
              </div>
              <p className="studio-run__specification">{run.specification}</p>
              {run.lastError ? (
                <p className="studio-note" data-testid="studio-run-recovery-note" role="status">
                  {run.lastError}
                </p>
              ) : null}
              <p className="studio-run__revision">
                Specification revision {run.specificationRevision ?? 1}
              </p>
              {(run.corrections ?? []).length > 0 ? (
                <ol aria-label="Live correction history">
                  {(run.corrections ?? []).map((correction) => (
                    <li key={correction.id}>
                      Revision {correction.specificationRevision} · {correction.status}:{" "}
                      {correction.instruction}
                      {correction.reconciliationSummary
                        ? ` — Reconciled: ${correction.reconciliationSummary}`
                        : ""}
                    </li>
                  ))}
                </ol>
              ) : null}
              <ol>
                {run.milestones.map((milestone) => {
                  const checkpoint = milestone.githubCheckpoints?.at(-1);
                  const pullRequestUrl = checkpoint?.pullRequestUrl ?? milestone.pullRequestUrl;
                  const reviewStatus = checkpoint
                    ? studioExternalReviewStatus(milestone, checkpoint.headSha)
                    : undefined;
                  const workers = studioRunWorkerRows(run, milestone, orchestrationChildren);
                  return (
                    <li key={milestone.id}>
                      {milestone.title} <span>· {milestone.status}</span>
                      {workers.length > 0 ? (
                        <ul
                          className="studio-run__workers"
                          aria-label={`${milestone.title} workers`}
                        >
                          {workers.map(({ workerId, child }) => (
                            <li className="studio-run__worker" key={workerId}>
                              {child ? (
                                <>
                                  <strong>{child.role ?? "Role not recorded"}</strong>
                                  <span>
                                    {child.model
                                      ? `${child.model.provider}/${child.model.modelId}`
                                      : "Model route not reported"}
                                  </span>
                                  <span>· {child.status}</span>
                                  <span>
                                    ·{" "}
                                    {child.environment === "worktree"
                                      ? "worktree"
                                      : "shared workspace"}
                                  </span>
                                  {child.branchName ? <code>{child.branchName}</code> : null}
                                  {child.worktreePath ? <code>{child.worktreePath}</code> : null}
                                  <button
                                    className="button studio-run__worker-open"
                                    onClick={() => {
                                      void updateSnapshot(setSnapshot, () =>
                                        api.selectSession({
                                          workspaceId: child.childWorkspaceId,
                                          sessionId: child.childSessionId,
                                        }),
                                      )
                                        .then(() =>
                                          updateSnapshot(setSnapshot, () =>
                                            api.setActiveView("threads"),
                                          ),
                                        )
                                        .catch((cause: unknown) => {
                                          setError(
                                            cause instanceof Error
                                              ? cause.message
                                              : "Studio could not open that worker thread.",
                                          );
                                        });
                                    }}
                                    type="button"
                                  >
                                    Open worker thread
                                  </button>
                                </>
                              ) : (
                                <span>Worker details not loaded · {workerId}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {pullRequestUrl ? (
                        <div
                          className="studio-run__review"
                          data-testid="studio-github-pull-request"
                        >
                          {checkpoint ? (
                            <>
                              <p>
                                GitHub review · {reviewStatus} · HEAD{" "}
                                <code>{checkpoint.headSha}</code>
                                {hasTrustedGitHubMergeForCheckpoint(checkpoint) &&
                                reviewStatus !== "merged" ? (
                                  <> GitHub already merged this SHA; Lucy review still open </>
                                ) : null}
                              </p>
                              <button
                                className="button"
                                disabled={
                                  Boolean(busyRunId) ||
                                  reviewStatus === "accepted" ||
                                  reviewStatus === "merged"
                                }
                                onClick={() => {
                                  confirmLucyDecision(
                                    run,
                                    milestone.id,
                                    checkpoint.headSha,
                                    "accepted",
                                  ).catch(() => undefined);
                                }}
                                type="button"
                              >
                                Confirm Lucy ACCEPT for this SHA
                              </button>
                              <button
                                className="button"
                                disabled={
                                  Boolean(busyRunId) ||
                                  reviewStatus === "changes-requested" ||
                                  reviewStatus === "merged"
                                }
                                onClick={() => {
                                  confirmLucyDecision(
                                    run,
                                    milestone.id,
                                    checkpoint.headSha,
                                    "changes-requested",
                                  ).catch(() => undefined);
                                }}
                                type="button"
                              >
                                Record Lucy changes requested
                              </button>
                            </>
                          ) : null}
                          <button
                            className="button"
                            disabled={Boolean(busyRunId)}
                            onClick={() => {
                              refreshGitHubPullRequest(run, milestone.id).catch(() => undefined);
                            }}
                            type="button"
                          >
                            Refresh from GitHub
                          </button>
                          <p className="studio-note">
                            Lucy confirmation is tied to the exact SHA. Merge status is shown only
                            after a direct read from GitHub.
                          </p>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
              <div className="studio-run__actions">
                {run.status !== "stopped" &&
                run.status !== "completed" &&
                run.coordinatorSessionId ? (
                  <div className="studio-run__correction">
                    <label className="studio-field">
                      <span>Live correction</span>
                      <textarea
                        rows={3}
                        value={correctionText}
                        placeholder="Describe a change to the active objective…"
                        onChange={(event) => setCorrectionText(event.currentTarget.value)}
                      />
                    </label>
                    <button
                      className="button"
                      disabled={Boolean(busyRunId) || !correctionText.trim()}
                      onClick={() => {
                        prepareCorrection(run).catch(() => undefined);
                      }}
                      type="button"
                    >
                      Prepare correction in coordinator
                    </button>
                    <p className="studio-note">
                      Records a new specification revision and places the correction in the
                      coordinator thread draft. Review and send it there; this does not call a
                      model.
                    </p>
                  </div>
                ) : null}
                {(run.status === "draft" || run.status === "paused" || run.status === "blocked") &&
                run.mode === "observed" ? (
                  <button
                    className="button"
                    disabled={
                      Boolean(busyRunId) ||
                      !run.coordinatorSessionId ||
                      selectedThreadTarget?.workspaceId !== run.workspaceId ||
                      selectedThreadTarget.sessionId !== run.coordinatorSessionId
                    }
                    onClick={() => {
                      startRun(run).catch(() => undefined);
                    }}
                    type="button"
                  >
                    {run.status === "paused"
                      ? "Resume after reconciliation"
                      : "Start in prepared thread"}
                  </button>
                ) : null}
                {run.status === "running" ? (
                  <button
                    className="button"
                    disabled={Boolean(busyRunId)}
                    onClick={() => changeStatus(run, "paused")}
                    type="button"
                  >
                    Pause new dispatch
                  </button>
                ) : null}
                {run.status !== "stopped" && run.status !== "completed" ? (
                  <button
                    className="button"
                    disabled={Boolean(busyRunId)}
                    onClick={() => {
                      stopRun(run).catch(() => undefined);
                    }}
                    type="button"
                  >
                    Stop run and cancel workers
                  </button>
                ) : null}
                {busyRunId === run.id ? <span role="status">Saving…</span> : null}
              </div>
            </article>
          ))}
        </section>
        {error ? (
          <p className="studio-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
