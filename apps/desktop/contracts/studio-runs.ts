/** Durable, project-scoped state for Matthew Way Studio orchestration. */
export const STUDIO_RUNS_FILE_VERSION = 1;
export const MAX_STUDIO_RUNS = 100;
export const MAX_STUDIO_MILESTONES = 100;
export const MAX_STUDIO_CORRECTIONS = 100;

export type StudioRunMode = "observed" | "autonomous";
export type StudioRunStatus = "draft" | "running" | "paused" | "stopped" | "completed" | "blocked";
export type StudioMilestoneStatus =
  "queued" | "running" | "verifying" | "repair-needed" | "complete" | "blocked" | "cancelled";

export type StudioExternalReviewDecision = "changes-requested" | "accepted" | "merged";

export interface ConfirmStudioExternalReviewInput {
  readonly runId: string;
  readonly milestoneId: string;
  readonly reviewedHeadSha: string;
  readonly decision: "changes-requested" | "accepted";
}

export interface StudioGitHubReview {
  readonly decision: StudioExternalReviewDecision;
  readonly reviewedHeadSha: string;
  readonly recordedAt: string;
  /** Legacy claims remain readable but are never authoritative. */
  readonly source: "matthew-confirmed-lucy" | "legacy-unverified";
  readonly mergeCommitSha?: string;
  readonly mergedAt?: string;
}

export interface StudioGitHubCheckpoint {
  readonly repository: string;
  readonly branch: string;
  readonly pullRequestUrl: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly pushedAt: string;
  readonly reviewHistory: readonly StudioGitHubReview[];
}

export type StudioExternalReviewStatus =
  "awaiting-lucy" | "changes-requested" | "accepted" | "superseded";

export interface StudioMilestone {
  readonly id: string;
  readonly title: string;
  readonly instruction: string;
  readonly dependsOn: readonly string[];
  readonly status: StudioMilestoneStatus;
  readonly workerThreadIds: readonly string[];
  readonly worktreeIds: readonly string[];
  readonly checkpointSha?: string;
  readonly pullRequestUrl?: string;
  /** Append-only GitHub checkpoint history; legacy checkpoint fields remain readable. */
  readonly githubCheckpoints?: readonly StudioGitHubCheckpoint[];
  readonly updatedAt: string;
}

function validSha(sha: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(sha);
}

/** Records a pushed PR checkpoint while retaining every previous reviewed SHA. */
export function recordStudioGitHubCheckpoint(
  milestone: StudioMilestone,
  input: Omit<StudioGitHubCheckpoint, "reviewHistory"> & { readonly now?: string },
): StudioMilestone {
  if (!validSha(input.baseSha) || !validSha(input.headSha)) {
    throw new Error("GitHub checkpoint requires full base and pushed HEAD SHAs.");
  }
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(input.pullRequestUrl)) {
    throw new Error("GitHub checkpoint requires a pull request URL.");
  }
  const checkpoints = milestone.githubCheckpoints ?? [];
  const existing = checkpoints.find(
    ({ headSha }) => headSha.toLowerCase() === input.headSha.toLowerCase(),
  );
  if (existing) {
    if (
      existing.repository !== input.repository ||
      existing.branch !== input.branch ||
      existing.pullRequestUrl !== input.pullRequestUrl ||
      existing.baseSha !== input.baseSha ||
      existing.pushedAt !== input.pushedAt
    ) {
      throw new Error("An existing GitHub checkpoint SHA cannot be rewritten.");
    }
    return milestone;
  }
  const { now, ...checkpoint } = input;
  const newCheckpoint: StudioGitHubCheckpoint = { ...checkpoint, reviewHistory: [] };
  return {
    ...milestone,
    githubCheckpoints: [...checkpoints, newCheckpoint],
    checkpointSha: input.headSha,
    pullRequestUrl: input.pullRequestUrl,
    updatedAt: now ?? new Date().toISOString(),
  };
}

/** Records an explicitly confirmed Lucy decision for the exact checkpoint SHA. */
export function recordStudioGitHubReview(
  milestone: StudioMilestone,
  input: {
    readonly headSha: string;
    readonly decision: "changes-requested" | "accepted";
    readonly now?: string;
  },
): StudioMilestone {
  const checkpoints = [...(milestone.githubCheckpoints ?? [])];
  const index = checkpoints.findIndex(
    ({ headSha }) => headSha.toLowerCase() === input.headSha.toLowerCase(),
  );
  if (index < 0) throw new Error("Review must name an exactly recorded checkpoint SHA.");
  const checkpoint = checkpoints[index]!;
  const latestTrusted = [...checkpoint.reviewHistory]
    .reverse()
    .find(({ source }) => source === "matthew-confirmed-lucy");
  if (latestTrusted?.decision === input.decision) return milestone;
  checkpoints[index] = {
    ...checkpoint,
    reviewHistory: [
      ...checkpoint.reviewHistory,
      {
        decision: input.decision,
        reviewedHeadSha: input.headSha,
        recordedAt: input.now ?? new Date().toISOString(),
        source: "matthew-confirmed-lucy",
      },
    ],
  };
  return {
    ...milestone,
    githubCheckpoints: checkpoints,
    updatedAt: input.now ?? new Date().toISOString(),
  };
}

export function studioExternalReviewStatus(
  milestone: StudioMilestone,
  headSha: string,
): StudioExternalReviewStatus {
  const checkpoints = milestone.githubCheckpoints ?? [];
  const reverseIndex = [...checkpoints]
    .reverse()
    .findIndex(({ headSha: sha }) => sha.toLowerCase() === headSha.toLowerCase());
  const index = reverseIndex < 0 ? -1 : checkpoints.length - 1 - reverseIndex;
  if (index < 0) throw new Error("Unknown GitHub checkpoint SHA.");
  if (index !== checkpoints.length - 1) return "superseded";
  const checkpoint = checkpoints[index]!;
  const review = [...checkpoint.reviewHistory].reverse().find(
    (
      candidate,
    ): candidate is StudioGitHubReview & {
      decision: "changes-requested" | "accepted";
    } =>
      candidate.source === "matthew-confirmed-lucy" &&
      candidate.decision !== "merged" &&
      candidate.reviewedHeadSha.toLowerCase() === checkpoint.headSha.toLowerCase(),
  );
  return review?.decision ?? "awaiting-lucy";
}

export interface StudioCorrection {
  readonly id: string;
  readonly specificationRevision: number;
  readonly instruction: string;
  readonly affectedMilestoneIds: readonly string[];
  readonly status: "prepared" | "sent" | "applied" | "superseded";
  readonly recordedAt: string;
}

export interface StudioRun {
  readonly id: string;
  readonly workspaceId: string;
  readonly repositoryPath: string;
  readonly specification: string;
  /** Session that received this run's /studio planning packet, when prepared from Studio. */
  readonly coordinatorSessionId?: string;
  /** Increments when Matthew or Lucy changes the active objective. */
  readonly specificationRevision?: number;
  readonly corrections?: readonly StudioCorrection[];
  readonly mode: StudioRunMode;
  readonly status: StudioRunStatus;
  readonly milestones: readonly StudioMilestone[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
  readonly lastError?: string;
}

/** Model-authored saves may append milestones, but cannot rewrite plan identity or persisted history. */
export function preserveStudioRunHistory(
  current: StudioRun | undefined,
  next: StudioRun,
  allowGitHubEvidenceAppend = false,
): StudioRun {
  if (!current) {
    if (
      next.milestones.some(({ githubCheckpoints }) =>
        (githubCheckpoints ?? []).some(({ reviewHistory }) => reviewHistory.length > 0),
      )
    ) {
      throw new Error("GitHub review evidence requires its authorised confirmation path.");
    }
    return next;
  }
  if (next.milestones.length < current.milestones.length) {
    throw new Error("Existing Studio milestones cannot be removed.");
  }
  const milestones = next.milestones.map((milestone, index) => {
    const previous = current.milestones[index];
    if (!previous) {
      if (
        (milestone.githubCheckpoints ?? []).some(({ reviewHistory }) => reviewHistory.length > 0)
      ) {
        throw new Error("GitHub review evidence requires its authorised confirmation path.");
      }
      return milestone;
    }
    if (
      milestone.id !== previous.id ||
      milestone.title !== previous.title ||
      milestone.instruction !== previous.instruction ||
      JSON.stringify(milestone.dependsOn) !== JSON.stringify(previous.dependsOn)
    ) {
      throw new Error("Existing Studio milestone identities and dependencies are immutable.");
    }
    if (
      !isPrefix(previous.workerThreadIds, milestone.workerThreadIds) ||
      !isPrefix(previous.worktreeIds, milestone.worktreeIds)
    ) {
      throw new Error(
        "Existing Studio worker and worktree history cannot be removed or reordered.",
      );
    }
    if (
      (previous.githubCheckpoints?.length ?? 0) > 0 &&
      milestone.githubCheckpoints === undefined
    ) {
      throw new Error("Existing GitHub checkpoint and review history cannot be deleted.");
    }
    const oldCheckpoints = previous.githubCheckpoints ?? [];
    const newCheckpoints = milestone.githubCheckpoints ?? [];
    if (newCheckpoints.length < oldCheckpoints.length) {
      throw new Error("Existing GitHub checkpoint and review history cannot be deleted.");
    }
    for (let checkpointIndex = 0; checkpointIndex < oldCheckpoints.length; checkpointIndex += 1) {
      const oldCheckpoint = oldCheckpoints[checkpointIndex]!;
      const newCheckpoint = newCheckpoints[checkpointIndex];
      if (!newCheckpoint || !sameCheckpointIdentity(oldCheckpoint, newCheckpoint)) {
        throw new Error("Existing GitHub checkpoint identity is immutable.");
      }
      const oldReviews = oldCheckpoint.reviewHistory;
      const newReviews = newCheckpoint.reviewHistory;
      if (
        newReviews.length < oldReviews.length ||
        !oldReviews.every(
          (review, reviewIndex) =>
            JSON.stringify(review) === JSON.stringify(newReviews[reviewIndex]),
        )
      ) {
        throw new Error("Existing GitHub review history cannot be deleted or rewritten.");
      }
      const appendedReviews = newReviews.slice(oldReviews.length);
      if (
        appendedReviews.length > 0 &&
        (!allowGitHubEvidenceAppend ||
          appendedReviews.some(
            ({ source, decision, reviewedHeadSha }) =>
              source !== "matthew-confirmed-lucy" ||
              decision === "merged" ||
              reviewedHeadSha.toLowerCase() !== oldCheckpoint.headSha.toLowerCase(),
          ))
      ) {
        throw new Error("GitHub review evidence requires its authorised confirmation path.");
      }
    }
    for (const checkpoint of newCheckpoints.slice(oldCheckpoints.length)) {
      if (checkpoint.reviewHistory.length > 0) {
        throw new Error("GitHub review evidence requires its authorised confirmation path.");
      }
    }
    if (
      milestone.checkpointSha !== undefined &&
      milestone.checkpointSha !== previous.checkpointSha
    ) {
      throw new Error("Existing GitHub checkpoint identity is immutable.");
    }
    if (
      milestone.pullRequestUrl !== undefined &&
      milestone.pullRequestUrl !== previous.pullRequestUrl
    ) {
      throw new Error("Existing GitHub checkpoint identity is immutable.");
    }
    return {
      ...milestone,
      ...((milestone.githubCheckpoints ?? previous.githubCheckpoints)
        ? { githubCheckpoints: milestone.githubCheckpoints ?? previous.githubCheckpoints }
        : {}),
      ...((milestone.checkpointSha ?? previous.checkpointSha)
        ? { checkpointSha: milestone.checkpointSha ?? previous.checkpointSha }
        : {}),
      ...((milestone.pullRequestUrl ?? previous.pullRequestUrl)
        ? { pullRequestUrl: milestone.pullRequestUrl ?? previous.pullRequestUrl }
        : {}),
    };
  });
  return { ...next, milestones };
}

function sameCheckpointIdentity(
  left: StudioGitHubCheckpoint,
  right: StudioGitHubCheckpoint,
): boolean {
  return (
    left.repository === right.repository &&
    left.branch === right.branch &&
    left.pullRequestUrl === right.pullRequestUrl &&
    left.baseSha === right.baseSha &&
    left.headSha === right.headSha &&
    left.pushedAt === right.pushedAt
  );
}

function isPrefix(previous: readonly string[], next: readonly string[]): boolean {
  return previous.length <= next.length && previous.every((value, index) => next[index] === value);
}

export function recordStudioCorrection(
  run: StudioRun,
  input: {
    readonly id: string;
    readonly instruction: string;
    readonly affectedMilestoneIds?: readonly string[];
    readonly now?: string;
  },
): StudioRun {
  if (run.status === "completed" || run.status === "stopped") {
    throw new Error(`Cannot steer a ${run.status} Studio run.`);
  }
  const instruction = input.instruction.trim();
  if (!instruction) throw new Error("A Studio correction cannot be empty.");
  const affectedMilestoneIds = [...new Set(input.affectedMilestoneIds ?? [])];
  const knownMilestones = new Set(run.milestones.map(({ id }) => id));
  if (affectedMilestoneIds.some((id) => !knownMilestones.has(id))) {
    throw new Error("A Studio correction references an unknown milestone.");
  }
  const specificationRevision = (run.specificationRevision ?? 1) + 1;
  const now = input.now ?? new Date().toISOString();
  return {
    ...run,
    specificationRevision,
    corrections: [
      ...(run.corrections ?? []),
      {
        id: input.id,
        specificationRevision,
        instruction,
        affectedMilestoneIds,
        status: "prepared",
        recordedAt: now,
      },
    ],
    updatedAt: now,
    revision: run.revision + 1,
  };
}

export interface StudioRunsFile {
  readonly version: typeof STUDIO_RUNS_FILE_VERSION;
  readonly runs: readonly StudioRun[];
}

export function availableStudioMilestones(run: StudioRun): readonly StudioMilestone[] {
  if (run.status !== "running") return [];
  const complete = new Set(
    run.milestones.filter((milestone) => milestone.status === "complete").map(({ id }) => id),
  );
  return run.milestones.filter(
    (milestone) =>
      milestone.status === "queued" &&
      milestone.dependsOn.every((dependency) => complete.has(dependency)),
  );
}

export function transitionStudioRun(
  run: StudioRun,
  status: StudioRunStatus,
  now = new Date().toISOString(),
): StudioRun {
  if (run.status === "completed" || run.status === "stopped") {
    throw new Error(`A ${run.status} Studio run is terminal.`);
  }
  const allowed: Readonly<Record<StudioRunStatus, readonly StudioRunStatus[]>> = {
    draft: ["running", "stopped"],
    running: ["paused", "stopped", "completed", "blocked"],
    paused: ["running", "stopped"],
    blocked: ["running", "stopped"],
    stopped: [],
    completed: [],
  };
  if (!allowed[run.status].includes(status)) {
    throw new Error(`Cannot move a ${run.status} Studio run to ${status}.`);
  }
  if (
    status === "completed" &&
    run.milestones.some((milestone) => milestone.status !== "complete")
  ) {
    throw new Error("A Studio run cannot complete while milestones remain unfinished.");
  }
  return {
    ...run,
    status,
    milestones:
      status === "stopped"
        ? run.milestones.map((milestone) =>
            milestone.status === "queued"
              ? { ...milestone, status: "cancelled", updatedAt: now }
              : milestone,
          )
        : run.milestones,
    updatedAt: now,
    revision: run.revision + 1,
  };
}

/** Applies one explicit milestone transition; completed dependencies are immutable. */
export function transitionStudioMilestone(
  run: StudioRun,
  milestoneId: string,
  status: StudioMilestoneStatus,
  now = new Date().toISOString(),
): StudioRun {
  if (run.status !== "running")
    throw new Error("Milestones can change only while a Studio run is running.");
  const target = run.milestones.find(({ id }) => id === milestoneId);
  if (!target) throw new Error("Unknown Studio milestone.");
  if (target.status === "complete" || target.status === "cancelled") {
    throw new Error(`A ${target.status} milestone is terminal.`);
  }
  const allowed: Readonly<Record<StudioMilestoneStatus, readonly StudioMilestoneStatus[]>> = {
    queued: ["running", "cancelled", "blocked"],
    running: ["verifying", "blocked", "cancelled"],
    verifying: ["repair-needed", "complete", "blocked"],
    "repair-needed": ["running", "blocked", "cancelled"],
    blocked: ["queued", "running", "cancelled"],
    complete: [],
    cancelled: [],
  };
  if (!allowed[target.status].includes(status)) {
    throw new Error(`Cannot move a ${target.status} milestone to ${status}.`);
  }
  if (
    status === "running" &&
    !availableStudioMilestones(run).some(({ id }) => id === milestoneId)
  ) {
    throw new Error("Milestone dependencies are not complete.");
  }
  const milestones = run.milestones.map((milestone) =>
    milestone.id === milestoneId ? { ...milestone, status, updatedAt: now } : milestone,
  );
  return { ...run, milestones, updatedAt: now, revision: run.revision + 1 };
}
