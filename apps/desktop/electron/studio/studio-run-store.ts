import {
  MAX_STUDIO_MILESTONES,
  MAX_STUDIO_CORRECTIONS,
  MAX_STUDIO_RUNS,
  STUDIO_RUNS_FILE_VERSION,
  type StudioMilestone,
  type StudioMilestoneStatus,
  type StudioCorrection,
  type StudioGitHubCheckpoint,
  type StudioGitHubReview,
  type StudioRun,
  type StudioRunMode,
  type StudioRunStatus,
  type StudioRunsFile,
} from "../../contracts/studio-runs";
import { readJsonWithBackup, writeFileAtomicQueued } from "../persistence/atomic-file-write";

const runStatuses: readonly StudioRunStatus[] = [
  "draft",
  "running",
  "paused",
  "stopped",
  "completed",
  "blocked",
];
const milestoneStatuses: readonly StudioMilestoneStatus[] = [
  "queued",
  "running",
  "verifying",
  "repair-needed",
  "complete",
  "blocked",
  "cancelled",
];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`Invalid ${at}.${key}`);
}

function text(value: unknown, at: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${at}`);
  return value.trim();
}

function optionalText(value: unknown, at: string): string | undefined {
  return value === undefined ? undefined : text(value, at);
}

function stringList(value: unknown, at: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`Invalid ${at}`);
  }
  return value.map((entry: string) => entry.trim());
}

function decodeMilestone(value: unknown, at: string): StudioMilestone {
  if (!record(value)) throw new Error(`Invalid ${at}`);
  keys(
    value,
    [
      "id",
      "title",
      "instruction",
      "dependsOn",
      "status",
      "workerThreadIds",
      "worktreeIds",
      "checkpointSha",
      "pullRequestUrl",
      "githubCheckpoints",
      "updatedAt",
    ],
    at,
  );
  if (
    value.status !== "awaiting-review" &&
    !milestoneStatuses.includes(value.status as StudioMilestoneStatus)
  )
    throw new Error(`Invalid ${at}.status`);
  const githubCheckpoints =
    value.githubCheckpoints === undefined
      ? undefined
      : decodeGitHubCheckpoints(value.githubCheckpoints, `${at}.githubCheckpoints`);
  return {
    id: text(value.id, `${at}.id`),
    title: text(value.title, `${at}.title`),
    instruction: text(value.instruction, `${at}.instruction`),
    dependsOn: stringList(value.dependsOn, `${at}.dependsOn`),
    // Old ledgers used this execution status for a pending external PR review.
    // Preserve the internal completion meaning and keep the legacy PR metadata readable.
    status:
      value.status === "awaiting-review" ? "complete" : (value.status as StudioMilestoneStatus),
    workerThreadIds: stringList(value.workerThreadIds, `${at}.workerThreadIds`),
    worktreeIds: stringList(value.worktreeIds, `${at}.worktreeIds`),
    ...(optionalText(value.checkpointSha, `${at}.checkpointSha`)
      ? { checkpointSha: value.checkpointSha as string }
      : {}),
    ...(optionalText(value.pullRequestUrl, `${at}.pullRequestUrl`)
      ? { pullRequestUrl: value.pullRequestUrl as string }
      : {}),
    ...(githubCheckpoints ? { githubCheckpoints } : {}),
    updatedAt: text(value.updatedAt, `${at}.updatedAt`),
  };
}

const reviewDecisions = ["changes-requested", "accepted", "merged"] as const;

function decodeGitHubCheckpoints(value: unknown, at: string): readonly StudioGitHubCheckpoint[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error(`Invalid ${at}`);
  return value.map((entry, index) => {
    const itemAt = `${at}[${index}]`;
    if (!record(entry)) throw new Error(`Invalid ${itemAt}`);
    keys(
      entry,
      ["repository", "branch", "pullRequestUrl", "baseSha", "headSha", "pushedAt", "reviewHistory"],
      itemAt,
    );
    if (!Array.isArray(entry.reviewHistory) || entry.reviewHistory.length > 100)
      throw new Error(`Invalid ${itemAt}.reviewHistory`);
    const reviewHistory = entry.reviewHistory.map((raw, reviewIndex): StudioGitHubReview => {
      const reviewAt = `${itemAt}.reviewHistory[${reviewIndex}]`;
      if (!record(raw)) throw new Error(`Invalid ${reviewAt}`);
      keys(
        raw,
        ["decision", "reviewedHeadSha", "recordedAt", "source", "mergeCommitSha", "mergedAt"],
        reviewAt,
      );
      if (!reviewDecisions.includes(raw.decision as StudioGitHubReview["decision"]))
        throw new Error(`Invalid ${reviewAt}.decision`);
      if (
        !["matthew", "github-api", "matthew-confirmed-lucy", "legacy-unverified"].includes(
          String(raw.source),
        )
      )
        throw new Error(`Invalid ${reviewAt}.source`);
      if (
        raw.decision === "merged" &&
        (raw.source === "matthew-confirmed-lucy" || !raw.mergeCommitSha || !raw.mergedAt)
      )
        throw new Error(`Invalid ${reviewAt} merge evidence`);
      if (
        typeof raw.reviewedHeadSha !== "string" ||
        raw.reviewedHeadSha.toLowerCase() !== String(entry.headSha).toLowerCase()
      )
        throw new Error(`Invalid ${reviewAt}.reviewedHeadSha binding`);
      return {
        decision: raw.decision as StudioGitHubReview["decision"],
        reviewedHeadSha: text(raw.reviewedHeadSha, `${reviewAt}.reviewedHeadSha`),
        recordedAt: text(raw.recordedAt, `${reviewAt}.recordedAt`),
        source:
          raw.source === "matthew-confirmed-lucy" ? "matthew-confirmed-lucy" : "legacy-unverified",
        ...(optionalText(raw.mergeCommitSha, `${reviewAt}.mergeCommitSha`)
          ? { mergeCommitSha: raw.mergeCommitSha as string }
          : {}),
        ...(optionalText(raw.mergedAt, `${reviewAt}.mergedAt`)
          ? { mergedAt: raw.mergedAt as string }
          : {}),
      };
    });
    const checkpoint = {
      repository: text(entry.repository, `${itemAt}.repository`),
      branch: text(entry.branch, `${itemAt}.branch`),
      pullRequestUrl: text(entry.pullRequestUrl, `${itemAt}.pullRequestUrl`),
      baseSha: text(entry.baseSha, `${itemAt}.baseSha`),
      headSha: text(entry.headSha, `${itemAt}.headSha`),
      pushedAt: text(entry.pushedAt, `${itemAt}.pushedAt`),
      reviewHistory,
    };
    if (
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(checkpoint.baseSha) ||
      !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(checkpoint.headSha)
    )
      throw new Error(`Invalid ${itemAt} SHA`);
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(checkpoint.pullRequestUrl))
      throw new Error(`Invalid ${itemAt}.pullRequestUrl`);
    return checkpoint;
  });
}

function decodeCorrection(value: unknown, at: string): StudioCorrection {
  if (!record(value)) throw new Error(`Invalid ${at}`);
  keys(
    value,
    ["id", "specificationRevision", "instruction", "affectedMilestoneIds", "status", "recordedAt"],
    at,
  );
  if (
    !Number.isSafeInteger(value.specificationRevision) ||
    (value.specificationRevision as number) < 2
  ) {
    throw new Error(`Invalid ${at}.specificationRevision`);
  }
  if (!["prepared", "sent", "applied", "superseded"].includes(String(value.status))) {
    throw new Error(`Invalid ${at}.status`);
  }
  return {
    id: text(value.id, `${at}.id`),
    specificationRevision: value.specificationRevision as number,
    instruction: text(value.instruction, `${at}.instruction`),
    affectedMilestoneIds: stringList(value.affectedMilestoneIds, `${at}.affectedMilestoneIds`),
    status: value.status as StudioCorrection["status"],
    recordedAt: text(value.recordedAt, `${at}.recordedAt`),
  };
}

function decodeRun(value: unknown, at: string): StudioRun {
  if (!record(value)) throw new Error(`Invalid ${at}`);
  keys(
    value,
    [
      "id",
      "workspaceId",
      "repositoryPath",
      "specification",
      "coordinatorSessionId",
      "specificationRevision",
      "corrections",
      "mode",
      "status",
      "milestones",
      "createdAt",
      "updatedAt",
      "revision",
      "lastError",
    ],
    at,
  );
  if (value.mode !== "observed" && value.mode !== "autonomous")
    throw new Error(`Invalid ${at}.mode`);
  if (!runStatuses.includes(value.status as StudioRunStatus))
    throw new Error(`Invalid ${at}.status`);
  if (!Array.isArray(value.milestones) || value.milestones.length > MAX_STUDIO_MILESTONES)
    throw new Error(`Invalid ${at}.milestones`);
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0)
    throw new Error(`Invalid ${at}.revision`);
  const milestones = value.milestones.map((item, index) =>
    decodeMilestone(item, `${at}.milestones[${index}]`),
  );
  const ids = new Set(milestones.map(({ id }) => id));
  const specificationRevision = value.specificationRevision ?? 1;
  if (!Number.isSafeInteger(specificationRevision) || (specificationRevision as number) < 1) {
    throw new Error(`Invalid ${at}.specificationRevision`);
  }
  if (value.corrections !== undefined && !Array.isArray(value.corrections)) {
    throw new Error(`Invalid ${at}.corrections`);
  }
  const corrections = (value.corrections ?? []).map((item, index) =>
    decodeCorrection(item, `${at}.corrections[${index}]`),
  );
  if (corrections.length > MAX_STUDIO_CORRECTIONS) {
    throw new Error(`Invalid ${at}.corrections`);
  }
  if (
    new Set(corrections.map(({ id }) => id)).size !== corrections.length ||
    corrections.some((correction, index) => correction.specificationRevision !== index + 2) ||
    specificationRevision !== corrections.length + 1 ||
    corrections.some((correction) => correction.affectedMilestoneIds.some((id) => !ids.has(id)))
  ) {
    throw new Error(`Invalid ${at}.corrections revision sequence`);
  }
  if (
    ids.size !== milestones.length ||
    milestones.some(
      ({ dependsOn, id }) =>
        dependsOn.includes(id) || dependsOn.some((dependency) => !ids.has(dependency)),
    )
  ) {
    throw new Error(`Invalid ${at}.milestones dependencies`);
  }
  const byId = new Map(milestones.map((milestone) => [milestone.id, milestone] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Invalid ${at}.milestones dependency cycle`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const milestone of milestones) visit(milestone.id);
  return {
    id: text(value.id, `${at}.id`),
    workspaceId: text(value.workspaceId, `${at}.workspaceId`),
    repositoryPath: text(value.repositoryPath, `${at}.repositoryPath`),
    specification: text(value.specification, `${at}.specification`),
    ...(optionalText(value.coordinatorSessionId, `${at}.coordinatorSessionId`)
      ? { coordinatorSessionId: value.coordinatorSessionId as string }
      : {}),
    specificationRevision: specificationRevision as number,
    corrections,
    mode: value.mode as StudioRunMode,
    status: value.status as StudioRunStatus,
    milestones,
    createdAt: text(value.createdAt, `${at}.createdAt`),
    updatedAt: text(value.updatedAt, `${at}.updatedAt`),
    revision: value.revision as number,
    ...(optionalText(value.lastError, `${at}.lastError`)
      ? { lastError: value.lastError as string }
      : {}),
  };
}

export function decodeStudioRunsFile(value: unknown): StudioRunsFile {
  if (!record(value)) throw new Error("Invalid studio-runs file");
  keys(value, ["version", "runs"], "studio-runs");
  if (
    value.version !== STUDIO_RUNS_FILE_VERSION ||
    !Array.isArray(value.runs) ||
    value.runs.length > MAX_STUDIO_RUNS
  ) {
    throw new Error("Invalid studio-runs file version or run list");
  }
  const runs = value.runs.map((run, index) => decodeRun(run, `runs[${index}]`));
  if (new Set(runs.map(({ id }) => id)).size !== runs.length)
    throw new Error("Duplicate Studio run IDs");
  return { version: STUDIO_RUNS_FILE_VERSION, runs };
}

export async function readStudioRunsFile(filePath: string): Promise<StudioRunsFile> {
  const result = await readJsonWithBackup(filePath);
  if (result.corrupted && !result.recovered) {
    throw new Error(`Invalid studio-runs at ${filePath}; original data was retained.`);
  }
  return result.value === undefined
    ? { version: STUDIO_RUNS_FILE_VERSION, runs: [] }
    : decodeStudioRunsFile(result.value);
}

export async function writeStudioRunsFile(filePath: string, value: StudioRunsFile): Promise<void> {
  const checked = decodeStudioRunsFile(value);
  await writeFileAtomicQueued(
    filePath,
    `${JSON.stringify(checked, null, 2)}\n`,
    decodeStudioRunsFile,
  );
}
