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

export interface RecordStudioCorrectionInput {
  readonly runId: string;
  readonly id: string;
  readonly instruction: string;
  readonly affectedMilestoneIds?: readonly string[];
}

export interface StudioGitHubReview {
  readonly decision: StudioExternalReviewDecision;
  readonly reviewedHeadSha: string;
  readonly recordedAt: string;
  /** Legacy claims remain readable but are never authoritative. */
  readonly source: "matthew-confirmed-lucy" | "github-api" | "legacy-unverified";
  /** Present only for an actual GitHub API observation. */
  readonly observedAt?: string;
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

export interface StudioGitHubPullRequestObservation {
  readonly repository: string;
  readonly branch: string;
  readonly pullRequestUrl: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly observedAt: string;
  readonly merged: boolean;
  readonly mergeCommitSha?: string;
  readonly mergedAt?: string;
}

export interface ReconcileStudioGitHubPullRequestInput {
  readonly runId: string;
  readonly milestoneId: string;
}

export type StudioExternalReviewStatus =
  "awaiting-lucy" | "changes-requested" | "accepted" | "merged" | "superseded";

export type StudioMilestoneDeliveryRequirement = "github-pr" | "local";
export type StudioMilestoneVerificationRequirement =
  | "coordinator"
  | "independent-inspector";

/**
 * Host-owned run-level default for newly planned milestones. Only the authorised
 * UI creation path may record "local"; model-facing saves never set or change it.
 * Once persisted, the policy is immutable for the life of the run.
 */
export type StudioRunDeliveryPolicy = StudioMilestoneDeliveryRequirement;

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
  /** When 'github-pr', local verification alone does not unlock dependent milestones; merge observation is required. */
  readonly deliveryRequirement?: StudioMilestoneDeliveryRequirement;
  /**
   * Host-owned verification policy. Model-authored saves default to
   * independent-inspector; coordinator verification is authorised only by the
   * Studio UI for a local milestone.
   */
  readonly verificationRequirement?: StudioMilestoneVerificationRequirement;
  readonly updatedAt: string;
}

function resolvedStudioVerificationRequirement(
  milestone: Pick<StudioMilestone, "verificationRequirement">,
): StudioMilestoneVerificationRequirement {
  return milestone.verificationRequirement ?? "independent-inspector";
}

function assertStudioVerificationRequirement(milestone: StudioMilestone): void {
  const requirement = resolvedStudioVerificationRequirement(milestone);
  if (requirement === "coordinator" && milestone.deliveryRequirement !== "local") {
    throw new Error(
      "Coordinator verification is allowed only for a host-authorised local milestone.",
    );
  }
}

function validSha(sha: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(sha);
}

/** Records a pushed PR checkpoint while retaining every previous reviewed SHA. */
export function recordStudioGitHubCheckpoint(
  milestone: StudioMilestone,
  input: Omit<StudioGitHubCheckpoint, "reviewHistory"> & { readonly now?: string },
): StudioMilestone {
  if (milestone.deliveryRequirement === "local") {
    throw new Error("Cannot record a GitHub checkpoint for a local-only milestone.");
  }
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
  // Recovery from out-of-order reality: GitHub may observe a merge before
  // Lucy reviews the SHA. Recording that fact must never convert the merge
  // into acceptance, and Lucy must still be able to accept (or request
  // changes on) the exact SHA afterwards. Append-only; the merge observation
  // is preserved untouched.
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

/** Records only a merge observation carrying actual GitHub API metadata. */
export function recordStudioGitHubMerge(
  milestone: StudioMilestone,
  input: {
    readonly headSha: string;
    readonly mergeCommitSha: string;
    readonly mergedAt: string;
    readonly observedAt: string;
  },
): StudioMilestone {
  if (!validSha(input.mergeCommitSha)) {
    throw new Error("GitHub merge requires a full merge commit SHA.");
  }
  const checkpoints = [...(milestone.githubCheckpoints ?? [])];
  const index = checkpoints.findIndex(
    ({ headSha }) => headSha.toLowerCase() === input.headSha.toLowerCase(),
  );
  if (index < 0) throw new Error("Merge must match an exactly recorded checkpoint SHA.");
  const checkpoint = checkpoints[index]!;
  const priorMerge = checkpoint.reviewHistory.find(
    ({ decision, source }) => decision === "merged" && source === "github-api",
  );
  if (priorMerge) {
    if (
      priorMerge.mergeCommitSha === input.mergeCommitSha &&
      priorMerge.mergedAt === input.mergedAt
    ) {
      return milestone;
    }
    throw new Error("A GitHub checkpoint's merge observation cannot be rewritten.");
  }
  checkpoints[index] = {
    ...checkpoint,
    reviewHistory: [
      ...checkpoint.reviewHistory,
      {
        decision: "merged",
        reviewedHeadSha: input.headSha,
        recordedAt: input.observedAt,
        observedAt: input.observedAt,
        source: "github-api",
        mergeCommitSha: input.mergeCommitSha,
        mergedAt: input.mergedAt,
      },
    ],
  };
  return {
    ...milestone,
    githubCheckpoints: checkpoints,
    updatedAt: input.observedAt,
  };
}

function reviewTargetsCheckpoint(
  reviewedHeadSha: string,
  checkpointHeadSha: string,
): boolean {
  return reviewedHeadSha.toLowerCase() === checkpointHeadSha.toLowerCase();
}

/**
 * Trusted Lucy ACCEPT for the exact checkpoint SHA. Never transfers across
 * SHAs: a newer checkpoint invalidates prior acceptance for dependency
 * purposes, and each checkpoint is judged only by reviews naming its SHA.
 */
export function hasTrustedLucyAcceptForCheckpoint(checkpoint: {
  readonly headSha: string;
  readonly reviewHistory: readonly StudioGitHubReview[];
}): boolean {
  return checkpoint.reviewHistory.some(
    ({ decision, source, reviewedHeadSha }) =>
      decision === "accepted" &&
      source === "matthew-confirmed-lucy" &&
      reviewTargetsCheckpoint(reviewedHeadSha, checkpoint.headSha),
  );
}

/**
 * Trusted GitHub merge observation for the exact checkpoint SHA, with valid
 * merge evidence. Recording this fact never constitutes acceptance.
 */
export function hasTrustedGitHubMergeForCheckpoint(checkpoint: {
  readonly headSha: string;
  readonly reviewHistory: readonly StudioGitHubReview[];
}): boolean {
  return checkpoint.reviewHistory.some(
    ({ decision, source, reviewedHeadSha, observedAt, mergeCommitSha, mergedAt }) =>
      decision === "merged" &&
      source === "github-api" &&
      reviewTargetsCheckpoint(reviewedHeadSha, checkpoint.headSha) &&
      Boolean(observedAt && mergeCommitSha && mergedAt),
  );
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
  // A GitHub merge observation is code truth, never acceptance: a checkpoint
  // whose merge was observed before Lucy reviewed it stays reviewable.
  // "merged" requires BOTH trusted facts for the same exact SHA.
  if (
    hasTrustedGitHubMergeForCheckpoint(checkpoint) &&
    hasTrustedLucyAcceptForCheckpoint(checkpoint)
  ) {
    return "merged";
  }
  const review = [...checkpoint.reviewHistory]
    .reverse()
    .find(
      ({ source, reviewedHeadSha }) =>
        source === "matthew-confirmed-lucy" &&
        reviewTargetsCheckpoint(reviewedHeadSha, checkpoint.headSha),
    );
  if (!review || review.decision === "merged") return "awaiting-lucy";
  return review.decision;
}

/** Applies a trusted, read-only GitHub API observation to the append-only checkpoint history. */
export function applyStudioGitHubPullRequestObservation(
  milestone: StudioMilestone,
  observation: StudioGitHubPullRequestObservation,
): StudioMilestone {
  if (!validSha(observation.baseSha) || !validSha(observation.headSha)) {
    throw new Error("GitHub pull request observation requires full base and HEAD SHAs.");
  }
  const existingUrl =
    milestone.githubCheckpoints?.at(-1)?.pullRequestUrl ?? milestone.pullRequestUrl;
  if (
    !existingUrl ||
    existingUrl.replace(/\/$/, "") !== observation.pullRequestUrl.replace(/\/$/, "")
  ) {
    throw new Error("GitHub observation does not match the milestone pull request.");
  }
  let updated = milestone;
  const latest = milestone.githubCheckpoints?.at(-1);
  if (latest) {
    if (
      latest.repository.toLowerCase() !== observation.repository.toLowerCase() ||
      latest.branch !== observation.branch ||
      latest.pullRequestUrl.replace(/\/$/, "") !== observation.pullRequestUrl.replace(/\/$/, "")
    ) {
      throw new Error("GitHub observation does not match the saved checkpoint identity.");
    }
  }
  if (!latest || latest.headSha.toLowerCase() !== observation.headSha.toLowerCase()) {
    updated = recordStudioGitHubCheckpoint(milestone, {
      repository: observation.repository,
      branch: observation.branch,
      pullRequestUrl: observation.pullRequestUrl,
      baseSha: observation.baseSha,
      headSha: observation.headSha,
      pushedAt: observation.observedAt,
      now: observation.observedAt,
    });
  }
  if (observation.merged) {
    if (!observation.mergeCommitSha || !observation.mergedAt) {
      throw new Error("Merged GitHub response is missing merge commit evidence.");
    }
    const checkpoint = updated.githubCheckpoints?.at(-1);
    const alreadyRecorded = checkpoint?.reviewHistory.some(
      ({ decision, source, mergeCommitSha, mergedAt }) =>
        decision === "merged" &&
        source === "github-api" &&
        mergeCommitSha === observation.mergeCommitSha &&
        mergedAt === observation.mergedAt,
    );
    if (!alreadyRecorded) {
      updated = recordStudioGitHubMerge(updated, {
        headSha: observation.headSha,
        mergeCommitSha: observation.mergeCommitSha,
        mergedAt: observation.mergedAt,
        observedAt: observation.observedAt,
      });
    }
  }
  return updated;
}

export interface StudioCorrection {
  readonly id: string;
  readonly specificationRevision: number;
  readonly instruction: string;
  readonly affectedMilestoneIds: readonly string[];
  readonly status: "prepared" | "sent" | "applied" | "superseded";
  readonly reconciliationSummary?: string;
  readonly recordedAt: string;
}

export interface StudioRun {
  readonly id: string;
  readonly workspaceId: string;
  readonly repositoryPath: string;
  readonly specification: string;
  /** Session that received this run's /studio planning packet, when prepared from Studio. */
  readonly coordinatorSessionId?: string;
  /** Host-owned default delivery requirement for milestones appended to this run. */
  readonly deliveryPolicy?: StudioRunDeliveryPolicy;
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
  authority: "none" | "matthew-correction" | "lucy-confirmation" | "github-observer" = "none",
): StudioRun {
  if (!current) {
    if ((next.corrections?.length ?? 0) > 0) {
      throw new Error("Studio corrections require Matthew's authorised UI path.");
    }
    if (
      next.milestones.some(({ githubCheckpoints }) =>
        (githubCheckpoints ?? []).some(({ reviewHistory }) => reviewHistory.length > 0),
      )
    ) {
      throw new Error("GitHub review evidence requires its authorised confirmation path.");
    }
    for (const milestone of next.milestones) {
      assertStudioVerificationRequirement(milestone);
      if (
        milestone.deliveryRequirement !== "github-pr" &&
        milestone.deliveryRequirement !== "local"
      ) {
        throw new Error(
          `Every newly planned milestone must declare a delivery requirement ("github-pr" | "local"): milestone "${milestone.id}" is missing one.`,
        );
      }
      if (
        milestone.deliveryRequirement === "local" &&
        (milestone.pullRequestUrl !== undefined ||
          milestone.checkpointSha !== undefined ||
          (milestone.githubCheckpoints?.length ?? 0) > 0)
      ) {
        throw new Error(
          `Contradictory milestone delivery requirement: local milestone "${milestone.id}" cannot have GitHub checkpoints or PR URL.`,
        );
      }
    }
    return next;
  }
  if (next.milestones.length < current.milestones.length) {
    throw new Error("Existing Studio milestones cannot be removed.");
  }
  if ((next.deliveryPolicy ?? "github-pr") !== (current.deliveryPolicy ?? "github-pr")) {
    throw new Error("The Studio run delivery policy is host-owned and immutable.");
  }
  const previousCorrections = current.corrections ?? [];
  const nextCorrections = next.corrections ?? [];
  if (nextCorrections.length < previousCorrections.length) {
    throw new Error("Existing Studio correction history cannot be deleted.");
  }
  if (nextCorrections.length > previousCorrections.length + 1) {
    throw new Error("Studio corrections must be appended one at a time.");
  }
  let correctionTransitions = 0;
  for (let index = 0; index < previousCorrections.length; index += 1) {
    const previous = previousCorrections[index]!;
    const correction = nextCorrections[index];
    if (
      !correction ||
      correction.id !== previous.id ||
      correction.specificationRevision !== previous.specificationRevision ||
      correction.instruction !== previous.instruction ||
      JSON.stringify(correction.affectedMilestoneIds) !==
        JSON.stringify(previous.affectedMilestoneIds) ||
      correction.recordedAt !== previous.recordedAt ||
      (previous.reconciliationSummary !== undefined &&
        correction.reconciliationSummary !== previous.reconciliationSummary)
    ) {
      throw new Error("Existing Studio correction history is immutable.");
    }
    if (correction.status !== previous.status) {
      const allowed: Readonly<
        Record<StudioCorrection["status"], readonly StudioCorrection["status"][]>
      > = {
        prepared: ["sent", "superseded"],
        sent: ["applied", "superseded"],
        applied: [],
        superseded: [],
      };
      if (!allowed[previous.status].includes(correction.status)) {
        throw new Error("Studio correction status must follow its lifecycle.");
      }
      if (correction.status === "applied" && !correction.reconciliationSummary?.trim()) {
        throw new Error("Applied Studio corrections require a reconciliation summary.");
      }
      if (correction.status !== "applied" && correction.reconciliationSummary !== undefined) {
        throw new Error("Studio correction summaries are recorded only when applied.");
      }
      correctionTransitions += 1;
    }
  }
  if (correctionTransitions > 1) {
    throw new Error("Update one Studio correction transition at a time.");
  }
  const nextMilestonesById = new Map(next.milestones.map((milestone) => [milestone.id, milestone]));
  for (let index = 0; index < previousCorrections.length; index += 1) {
    const previous = previousCorrections[index]!;
    const correction = nextCorrections[index]!;
    if (
      previous.status === "sent" &&
      correction.status === "applied" &&
      correction.affectedMilestoneIds.some((id) => {
        const milestone = nextMilestonesById.get(id);
        return !milestone || (milestone.status !== "complete" && milestone.status !== "cancelled");
      })
    ) {
      throw new Error(
        "Affected Studio milestones must be completed or cancelled before applying the correction.",
      );
    }
  }
  if (nextCorrections.length > previousCorrections.length && authority !== "matthew-correction") {
    throw new Error("Studio corrections require Matthew's authorised UI path.");
  }
  const milestones = next.milestones.map((milestone, index) => {
    assertStudioVerificationRequirement(milestone);
    const previous = current.milestones[index];
    if (!previous) {
      if (
        milestone.deliveryRequirement !== "github-pr" &&
        milestone.deliveryRequirement !== "local"
      ) {
        throw new Error(
          `Every newly planned milestone must declare a delivery requirement ("github-pr" | "local"): milestone "${milestone.id}" is missing one.`,
        );
      }
      if (
        milestone.deliveryRequirement === "local" &&
        (milestone.pullRequestUrl !== undefined ||
          milestone.checkpointSha !== undefined ||
          (milestone.githubCheckpoints?.length ?? 0) > 0)
      ) {
        throw new Error(
          `Contradictory milestone delivery requirement: local milestone "${milestone.id}" cannot have GitHub checkpoints or PR URL.`,
        );
      }
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
      JSON.stringify(milestone.dependsOn) !== JSON.stringify(previous.dependsOn) ||
      milestone.deliveryRequirement !== previous.deliveryRequirement ||
      resolvedStudioVerificationRequirement(milestone) !==
        resolvedStudioVerificationRequirement(previous)
    ) {
      throw new Error("Existing Studio milestone identities and dependencies are immutable.");
    }
    if (
      milestone.deliveryRequirement === "local" &&
      (milestone.pullRequestUrl !== undefined ||
        milestone.checkpointSha !== undefined ||
        (milestone.githubCheckpoints?.length ?? 0) > 0)
    ) {
      throw new Error(
        `Contradictory milestone delivery requirement: local milestone "${milestone.id}" cannot have GitHub checkpoints or PR URL.`,
      );
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
        (authority === "none" ||
          appendedReviews.some(
            ({ source, decision, reviewedHeadSha, observedAt, mergeCommitSha, mergedAt }) => {
              if (reviewedHeadSha.toLowerCase() !== oldCheckpoint.headSha.toLowerCase()) {
                return true;
              }
              if (authority === "lucy-confirmation") {
                return source !== "matthew-confirmed-lucy" || decision === "merged";
              }
              return (
                source !== "github-api" ||
                decision !== "merged" ||
                !observedAt ||
                !validSha(mergeCommitSha ?? "") ||
                !mergedAt
              );
            },
          ))
      ) {
        throw new Error("GitHub review evidence requires its authorised confirmation path.");
      }
    }
    for (const checkpoint of newCheckpoints.slice(oldCheckpoints.length)) {
      if (
        checkpoint.reviewHistory.some(
          ({ source, decision, reviewedHeadSha, observedAt, mergeCommitSha, mergedAt }) =>
            authority !== "github-observer" ||
            source !== "github-api" ||
            decision !== "merged" ||
            reviewedHeadSha.toLowerCase() !== checkpoint.headSha.toLowerCase() ||
            !observedAt ||
            !validSha(mergeCommitSha ?? "") ||
            !mergedAt,
        )
      ) {
        throw new Error("GitHub review evidence requires its authorised confirmation path.");
      }
    }
    const latestNewCheckpoint = newCheckpoints.at(-1);
    const expectedCheckpointSha = latestNewCheckpoint?.headSha ?? previous.checkpointSha;
    const expectedPullRequestUrl = latestNewCheckpoint?.pullRequestUrl ?? previous.pullRequestUrl;
    // Legacy ledgers carry only checkpointSha/pullRequestUrl (no githubCheckpoints
    // array). Treat omission as a rewrite too, otherwise a model save can erase
    // legacy history (PR#1 db05974 "preserve legacy checkpoint identity").
    if (previous.checkpointSha !== undefined && milestone.checkpointSha === undefined) {
      throw new Error("Existing GitHub checkpoint identity is immutable.");
    }
    if (
      milestone.checkpointSha !== undefined &&
      expectedCheckpointSha !== undefined &&
      milestone.checkpointSha.toLowerCase() !== expectedCheckpointSha.toLowerCase()
    ) {
      throw new Error("Existing GitHub checkpoint identity is immutable.");
    }
    if (previous.pullRequestUrl !== undefined && milestone.pullRequestUrl === undefined) {
      throw new Error("Existing GitHub checkpoint identity is immutable.");
    }
    if (
      milestone.pullRequestUrl !== undefined &&
      expectedPullRequestUrl !== undefined &&
      milestone.pullRequestUrl.replace(/\/$/, "").toLowerCase() !==
        expectedPullRequestUrl.replace(/\/$/, "").toLowerCase()
    ) {
      throw new Error("Existing GitHub checkpoint identity is immutable.");
    }
    const resolvedCheckpoints =
      newCheckpoints.length > 0
        ? newCheckpoints
        : (milestone.githubCheckpoints ?? previous.githubCheckpoints);
    const resolvedLatest = resolvedCheckpoints?.at(-1);
    const resolvedSha =
      resolvedLatest?.headSha ?? milestone.checkpointSha ?? previous.checkpointSha;
    const resolvedUrl =
      resolvedLatest?.pullRequestUrl ?? milestone.pullRequestUrl ?? previous.pullRequestUrl;
    const resolvedDeliveryRequirement =
      milestone.deliveryRequirement ?? previous.deliveryRequirement;
    return {
      ...milestone,
      ...(resolvedCheckpoints ? { githubCheckpoints: resolvedCheckpoints } : {}),
      ...(resolvedSha ? { checkpointSha: resolvedSha } : {}),
      ...(resolvedUrl ? { pullRequestUrl: resolvedUrl } : {}),
      ...(resolvedDeliveryRequirement !== undefined
        ? { deliveryRequirement: resolvedDeliveryRequirement }
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

export function isStudioMilestoneDependencySatisfied(milestone: StudioMilestone): boolean {
  if (milestone.status !== "complete") return false;
  // A milestone with a PR URL or GitHub checkpoints must always require merge confirmation;
  // it must never bypass merge verification even if deliveryRequirement says "local".
  if (
    Boolean(milestone.pullRequestUrl) ||
    Boolean(milestone.githubCheckpoints && milestone.githubCheckpoints.length > 0)
  ) {
    const latestCheckpoint = milestone.githubCheckpoints?.at(-1);
    if (!latestCheckpoint) return false;
    // A GitHub-delivered milestone satisfies downstream dependencies only when
    // BOTH trusted facts exist for the same latest checkpoint SHA: Lucy has
    // explicitly accepted the exact SHA through the Matthew-confirmation path,
    // AND GitHub has observed that exact SHA merged. Merge truth alone — e.g. a
    // manually merged but never reviewed PR — never unlocks dependents.
    return (
      hasTrustedLucyAcceptForCheckpoint(latestCheckpoint) &&
      hasTrustedGitHubMergeForCheckpoint(latestCheckpoint)
    );
  }
  if (milestone.deliveryRequirement === "local") {
    return true;
  }
  // For 'github-pr' or an omitted requirement in the autonomous GitHub delivery workflow,
  // do not silently interpret a missing value as local-only: merge confirmation is required.
  return false;
}

export function availableStudioMilestones(run: StudioRun): readonly StudioMilestone[] {
  if (run.status !== "running") return [];
  const milestonesById = new Map(
    run.milestones.map((milestone) => [milestone.id, milestone] as const),
  );
  return run.milestones.filter(
    (milestone) =>
      milestone.status === "queued" &&
      milestone.dependsOn.every((dependencyId) => {
        const dependency = milestonesById.get(dependencyId);
        return dependency !== undefined && isStudioMilestoneDependencySatisfied(dependency);
      }),
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
    // Cancelled milestones are terminal (plan changes and stop both cancel work),
    // so they do not keep a finished run from completing.
    run.milestones.some(
      (milestone) => milestone.status !== "complete" && milestone.status !== "cancelled",
    )
  ) {
    throw new Error("A Studio run cannot complete while milestones remain unfinished.");
  }
  const { lastError, ...runWithoutLastError } = run;
  return {
    ...runWithoutLastError,
    ...(status === "running" || lastError === undefined ? {} : { lastError }),
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

/**
 * A desktop restart cannot prove that the prior coordinator or its workers are still running.
 * Pause persisted runs and require an explicit coordinator reconciliation before dispatch resumes.
 */
export function recoverStudioRunsAfterRestart(
  runs: readonly StudioRun[],
  now = new Date().toISOString(),
): readonly StudioRun[] {
  let recoveredAny = false;
  const recovered = runs.map((run) => {
    if (run.status !== "running") return run;
    recoveredAny = true;
    const paused = transitionStudioRun(run, "paused", now);
    const recoveryNote =
      "Restart recovery required: reconcile the current Pi coordinator and worker threads, repository state, verification results, and GitHub checkpoints before dispatching more work. Preserve completed work and do not duplicate milestones already running or complete.";
    return {
      ...paused,
      lastError: run.lastError?.trim()
        ? `${run.lastError.trim()}\n\n${recoveryNote}`
        : recoveryNote,
    };
  });
  return recoveredAny ? recovered : runs;
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
