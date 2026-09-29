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

export interface StudioGitHubReview {
  readonly decision: StudioExternalReviewDecision;
  readonly reviewedHeadSha: string;
  readonly recordedAt: string;
  /** Merged is recorded only from a GitHub API observation, never from pasted approval. */
  readonly source: "matthew" | "github-api";
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
  "awaiting-lucy" | "changes-requested" | "accepted" | "merged" | "superseded";

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
  if (checkpoints.some(({ headSha }) => headSha.toLowerCase() === input.headSha.toLowerCase())) {
    throw new Error("This pushed HEAD SHA is already recorded for the milestone.");
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

/** Records Matthew's exact-SHA review decision; merge requires separate GitHub evidence. */
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
  checkpoints[index] = {
    ...checkpoint,
    reviewHistory: [
      ...checkpoint.reviewHistory,
      {
        decision: input.decision,
        reviewedHeadSha: input.headSha,
        recordedAt: input.now ?? new Date().toISOString(),
        source: "matthew",
      },
    ],
  };
  return {
    ...milestone,
    githubCheckpoints: checkpoints,
    updatedAt: input.now ?? new Date().toISOString(),
  };
}

/** Only a GitHub API observation carrying merge metadata can establish merged state. */
export function recordStudioGitHubMerge(
  milestone: StudioMilestone,
  input: {
    readonly headSha: string;
    readonly mergeCommitSha: string;
    readonly mergedAt: string;
    readonly observedAt?: string;
  },
): StudioMilestone {
  if (!validSha(input.mergeCommitSha))
    throw new Error("GitHub merge requires a full merge commit SHA.");
  const checkpoints = [...(milestone.githubCheckpoints ?? [])];
  const index = checkpoints.findIndex(
    ({ headSha }) => headSha.toLowerCase() === input.headSha.toLowerCase(),
  );
  if (index < 0) throw new Error("Merge must match an exactly recorded checkpoint SHA.");
  const checkpoint = checkpoints[index]!;
  checkpoints[index] = {
    ...checkpoint,
    reviewHistory: [
      ...checkpoint.reviewHistory,
      {
        decision: "merged",
        reviewedHeadSha: input.headSha,
        recordedAt: input.observedAt ?? new Date().toISOString(),
        source: "github-api",
        mergeCommitSha: input.mergeCommitSha,
        mergedAt: input.mergedAt,
      },
    ],
  };
  return {
    ...milestone,
    githubCheckpoints: checkpoints,
    updatedAt: input.observedAt ?? new Date().toISOString(),
  };
}

export function studioExternalReviewStatus(
  milestone: StudioMilestone,
  headSha: string,
): StudioExternalReviewStatus {
  const checkpoints = milestone.githubCheckpoints ?? [];
  const index = checkpoints.findIndex(
    ({ headSha: sha }) => sha.toLowerCase() === headSha.toLowerCase(),
  );
  if (index < 0) throw new Error("Unknown GitHub checkpoint SHA.");
  if (index !== checkpoints.length - 1) return "superseded";
  const checkpoint = checkpoints[index]!;
  const review = [...checkpoint.reviewHistory]
    .reverse()
    .find(
      ({ reviewedHeadSha }) => reviewedHeadSha.toLowerCase() === checkpoint.headSha.toLowerCase(),
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
