import { expect, test } from "@playwright/test";
import {
  applyStudioGitHubPullRequestObservation,
  hasTrustedGitHubMergeForCheckpoint,
  hasTrustedLucyAcceptForCheckpoint,
  isStudioMilestoneDependencySatisfied,
  preserveStudioRunHistory,
  recordStudioGitHubCheckpoint,
  recordStudioGitHubReview,
  studioExternalReviewStatus,
  type StudioMilestone,
  type StudioRun,
} from "../../contracts/studio-runs";
import { decodeStudioRunsFile } from "../../electron/studio/studio-run-store";

const HEAD_A = "b".repeat(40);
const HEAD_B = "c".repeat(40);
const BASE = "a".repeat(40);
const MERGE = "d".repeat(40);
const URL = "https://github.com/owner/repo/pull/12";
const T0 = "2026-09-29T00:00:00.000Z";
const T1 = "2026-09-29T00:01:00.000Z";
const T2 = "2026-09-29T00:02:00.000Z";

const baseMilestone: StudioMilestone = {
  id: "m1",
  title: "Foundation",
  instruction: "Set up foundation",
  dependsOn: [],
  status: "complete",
  workerThreadIds: [],
  worktreeIds: [],
  deliveryRequirement: "github-pr",
  updatedAt: T0,
};

function checkpointMilestone(headSha: string): StudioMilestone {
  return recordStudioGitHubCheckpoint(baseMilestone, {
    repository: "owner/repo",
    branch: "studio/m1",
    pullRequestUrl: URL,
    baseSha: BASE,
    headSha,
    pushedAt: T0,
  });
}

function mergeObservation(headSha: string, at: string = T1) {
  return {
    repository: "owner/repo",
    branch: "studio/m1",
    pullRequestUrl: URL,
    baseSha: BASE,
    headSha,
    observedAt: at,
    merged: true,
    mergeCommitSha: MERGE,
    mergedAt: T1,
  };
}

test.describe("external acceptance and merge truth stay independent", () => {
  test("complete + awaiting Lucy + unmerged -> dependency false", () => {
    const milestone = checkpointMilestone(HEAD_A);
    expect(studioExternalReviewStatus(milestone, HEAD_A)).toBe("awaiting-lucy");
    expect(isStudioMilestoneDependencySatisfied(milestone)).toBe(false);
  });

  test("complete + Lucy accepted + unmerged -> dependency false", () => {
    const milestone = recordStudioGitHubReview(checkpointMilestone(HEAD_A), {
      headSha: HEAD_A,
      decision: "accepted",
      now: T1,
    });
    expect(studioExternalReviewStatus(milestone, HEAD_A)).toBe("accepted");
    expect(isStudioMilestoneDependencySatisfied(milestone)).toBe(false);
  });

  test("complete + GitHub merged + no Lucy acceptance -> dependency false", () => {
    const milestone = applyStudioGitHubPullRequestObservation(checkpointMilestone(HEAD_A), mergeObservation(HEAD_A));
    // The merge fact is recorded (code truth) but the checkpoint stays reviewable.
    expect(hasTrustedGitHubMergeForCheckpoint(milestone.githubCheckpoints![0]!)).toBe(true);
    expect(studioExternalReviewStatus(milestone, HEAD_A)).toBe("awaiting-lucy");
    expect(isStudioMilestoneDependencySatisfied(milestone)).toBe(false);
  });

  test("complete + GitHub merged + Lucy changes requested -> dependency false", () => {
    let milestone = applyStudioGitHubPullRequestObservation(checkpointMilestone(HEAD_A), mergeObservation(HEAD_A));
    milestone = recordStudioGitHubReview(milestone, { headSha: HEAD_A, decision: "changes-requested", now: T2 });
    expect(studioExternalReviewStatus(milestone, HEAD_A)).toBe("changes-requested");
    expect(isStudioMilestoneDependencySatisfied(milestone)).toBe(false);
  });

  test("complete + Lucy accepted exact SHA + GitHub merged exact SHA -> true", () => {
    let milestone = recordStudioGitHubReview(checkpointMilestone(HEAD_A), {
      headSha: HEAD_A,
      decision: "accepted",
      now: T1,
    });
    milestone = applyStudioGitHubPullRequestObservation(milestone, mergeObservation(HEAD_A, T2));
    expect(hasTrustedLucyAcceptForCheckpoint(milestone.githubCheckpoints![0]!)).toBe(true);
    expect(hasTrustedGitHubMergeForCheckpoint(milestone.githubCheckpoints![0]!)).toBe(true);
    expect(studioExternalReviewStatus(milestone, HEAD_A)).toBe("merged");
    expect(isStudioMilestoneDependencySatisfied(milestone)).toBe(true);
  });

  test("acceptance for an older SHA + merge of latest SHA -> false (no transfer)", () => {
    let milestone = recordStudioGitHubReview(checkpointMilestone(HEAD_A), {
      headSha: HEAD_A,
      decision: "accepted",
      now: T1,
    });
    milestone = applyStudioGitHubPullRequestObservation(milestone, mergeObservation(HEAD_A, T2));
    expect(isStudioMilestoneDependencySatisfied(milestone)).toBe(true);
    // A newer checkpoint arrives and merges. The old acceptance must not transfer.
    let next = recordStudioGitHubCheckpoint(milestone, {
      repository: "owner/repo",
      branch: "studio/m1",
      pullRequestUrl: URL,
      baseSha: BASE,
      headSha: HEAD_B,
      pushedAt: T2,
    });
    next = applyStudioGitHubPullRequestObservation(next, mergeObservation(HEAD_B, T2));
    expect(studioExternalReviewStatus(next, HEAD_B)).toBe("awaiting-lucy");
    expect(isStudioMilestoneDependencySatisfied(next)).toBe(false);
    expect(studioExternalReviewStatus(next, HEAD_A)).toBe("superseded");
  });

  test("merge observed first, then authorised Lucy ACCEPT for same SHA -> true after both", () => {
    let milestone = applyStudioGitHubPullRequestObservation(checkpointMilestone(HEAD_A), mergeObservation(HEAD_A));
    expect(studioExternalReviewStatus(milestone, HEAD_A)).toBe("awaiting-lucy");
    expect(isStudioMilestoneDependencySatisfied(milestone)).toBe(false);
    milestone = recordStudioGitHubReview(milestone, { headSha: HEAD_A, decision: "accepted", now: T2 });
    expect(studioExternalReviewStatus(milestone, HEAD_A)).toBe("merged");
    expect(isStudioMilestoneDependencySatisfied(milestone)).toBe(true);
  });

  test("merge observed first, then CHANGES REQUESTED -> remains false", () => {
    let milestone = applyStudioGitHubPullRequestObservation(checkpointMilestone(HEAD_A), mergeObservation(HEAD_A));
    milestone = recordStudioGitHubReview(milestone, { headSha: HEAD_A, decision: "changes-requested", now: T2 });
    expect(studioExternalReviewStatus(milestone, HEAD_A)).toBe("changes-requested");
    expect(isStudioMilestoneDependencySatisfied(milestone)).toBe(false);
  });

  test("generic/model save still cannot manufacture acceptance", () => {
    const milestone = checkpointMilestone(HEAD_A);
    const forged = {
      ...milestone,
      githubCheckpoints: [
        {
          ...milestone.githubCheckpoints![0]!,
          reviewHistory: [
            ...milestone.githubCheckpoints![0]!.reviewHistory,
            {
              decision: "accepted" as const,
              reviewedHeadSha: HEAD_A,
              recordedAt: T1,
              source: "matthew-confirmed-lucy" as const,
            },
          ],
        },
      ],
    };
    const run: StudioRun = {
      id: "run-1",
      workspaceId: "workspace-1",
      repositoryPath: "C:\\scratch\\repo",
      specification: "spec",
      mode: "observed",
      status: "running",
      createdAt: T0,
      updatedAt: T0,
      revision: 1,
      milestones: [milestone],
    };
    expect(() =>
      preserveStudioRunHistory(run, { ...run, milestones: [forged] }),
    ).toThrow("authorised confirmation");
  });

  test("generic/model save still cannot manufacture merge evidence", () => {
    const milestone = checkpointMilestone(HEAD_A);
    const forgedMerge = decodeStudioRunsFile({
      version: 1,
      runs: [
        {
          id: "run-1",
          workspaceId: "workspace-1",
          repositoryPath: "C:\\scratch\\repo",
          specification: "spec",
          mode: "observed",
          status: "running",
          createdAt: T0,
          updatedAt: T0,
          revision: 1,
          milestones: [
            {
              ...baseMilestone,
              githubCheckpoints: [
                {
                  ...milestone.githubCheckpoints![0]!,
                  reviewHistory: [
                    {
                      decision: "merged",
                      reviewedHeadSha: HEAD_A,
                      recordedAt: T1,
                      source: "github-api",
                      mergeCommitSha: MERGE,
                      mergedAt: T1,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }).runs[0]!;
    expect(forgedMerge.milestones[0]!.githubCheckpoints![0]!.reviewHistory.at(-1)).toMatchObject({
      decision: "merged",
      source: "legacy-unverified",
    });
    expect(isStudioMilestoneDependencySatisfied(forgedMerge.milestones[0]!)).toBe(false);
  });

  test("new checkpoint invalidates prior acceptance for dependency purposes", () => {
    const accepted = recordStudioGitHubReview(checkpointMilestone(HEAD_A), {
      headSha: HEAD_A,
      decision: "accepted",
      now: T1,
    });
    expect(isStudioMilestoneDependencySatisfied(accepted)).toBe(false);
    const next = recordStudioGitHubCheckpoint(accepted, {
      repository: "owner/repo",
      branch: "studio/m1",
      pullRequestUrl: URL,
      baseSha: BASE,
      headSha: HEAD_B,
      pushedAt: T2,
    });
    expect(isStudioMilestoneDependencySatisfied(next)).toBe(false);
    expect(studioExternalReviewStatus(next, HEAD_B)).toBe("awaiting-lucy");
  });
});
