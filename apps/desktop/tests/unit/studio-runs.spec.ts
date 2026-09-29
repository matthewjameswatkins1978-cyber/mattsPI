import { expect, test } from "@playwright/test";
import {
  availableStudioMilestones,
  recordStudioGitHubCheckpoint,
  recordStudioGitHubMerge,
  recordStudioGitHubReview,
  recordStudioCorrection,
  studioExternalReviewStatus,
  transitionStudioMilestone,
  transitionStudioRun,
  type StudioRun,
} from "../../contracts/studio-runs";
import { decodeStudioRunsFile } from "../../electron/studio/studio-run-store";

const run: StudioRun = {
  id: "run-1",
  workspaceId: "workspace-1",
  repositoryPath: "C:\\scratch\\repo",
  specification: "Implement a small three milestone demo.",
  mode: "observed",
  status: "running",
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z",
  revision: 1,
  milestones: [
    {
      id: "m1",
      title: "Foundation",
      instruction: "Set up foundation",
      dependsOn: [],
      status: "queued",
      workerThreadIds: [],
      worktreeIds: [],
      updatedAt: "2026-09-28T00:00:00.000Z",
    },
    {
      id: "m2",
      title: "Feature",
      instruction: "Implement feature",
      dependsOn: ["m1"],
      status: "queued",
      workerThreadIds: [],
      worktreeIds: [],
      updatedAt: "2026-09-28T00:00:00.000Z",
    },
  ],
};

test.describe("Studio run plan state", () => {
  test("keeps internal completion separate from SHA-bound Lucy review history", () => {
    const baseSha = "a".repeat(40);
    const firstSha = "b".repeat(40);
    const secondSha = "c".repeat(40);
    const mergeSha = "d".repeat(40);
    const [queued] = run.milestones;
    const internalComplete = { ...queued, status: "complete" as const };
    expect(internalComplete.status).toBe("complete");
    let milestone = recordStudioGitHubCheckpoint(internalComplete, {
      repository: "owner/repo",
      branch: "studio/m1",
      pullRequestUrl: "https://github.com/owner/repo/pull/12",
      baseSha,
      headSha: firstSha,
      pushedAt: "2026-09-29T00:00:00.000Z",
    });
    expect(studioExternalReviewStatus(milestone, firstSha)).toBe("awaiting-lucy");
    milestone = recordStudioGitHubReview(milestone, {
      headSha: firstSha,
      decision: "accepted",
      now: "2026-09-29T00:01:00.000Z",
    });
    expect(studioExternalReviewStatus(milestone, firstSha)).toBe("accepted");

    milestone = recordStudioGitHubCheckpoint(milestone, {
      repository: "owner/repo",
      branch: "studio/m1",
      pullRequestUrl: "https://github.com/owner/repo/pull/12",
      baseSha,
      headSha: secondSha,
      pushedAt: "2026-09-29T00:02:00.000Z",
    });
    expect(studioExternalReviewStatus(milestone, firstSha)).toBe("superseded");
    expect(studioExternalReviewStatus(milestone, secondSha)).toBe("awaiting-lucy");
    expect(milestone.githubCheckpoints?.[0].reviewHistory).toHaveLength(1);
    expect(() =>
      recordStudioGitHubReview(milestone, { headSha: "e".repeat(40), decision: "accepted" }),
    ).toThrow("exactly recorded");
    expect(() =>
      recordStudioGitHubMerge(milestone, {
        headSha: secondSha,
        mergeCommitSha: mergeSha,
        mergedAt: "2026-09-29T00:03:00.000Z",
      }),
    ).not.toThrow();
    const merged = recordStudioGitHubMerge(milestone, {
      headSha: secondSha,
      mergeCommitSha: mergeSha,
      mergedAt: "2026-09-29T00:03:00.000Z",
    });
    expect(studioExternalReviewStatus(merged, secondSha)).toBe("merged");
    expect(
      decodeStudioRunsFile({
        version: 1,
        runs: [{ ...run, milestones: [merged, run.milestones[1]] }],
      }).runs[0].milestones[0],
    ).toEqual(merged);
    expect(() =>
      decodeStudioRunsFile({
        version: 1,
        runs: [
          {
            ...run,
            milestones: [
              {
                ...merged,
                githubCheckpoints: [
                  {
                    ...merged.githubCheckpoints?.[1],
                    reviewHistory: [
                      {
                        decision: "merged",
                        reviewedHeadSha: secondSha,
                        recordedAt: "2026-09-29T00:03:00.000Z",
                        source: "matthew",
                        mergeCommitSha: mergeSha,
                        mergedAt: "2026-09-29T00:03:00.000Z",
                      },
                    ],
                  },
                ],
              },
              run.milestones[1],
            ],
          },
        ],
      }),
    ).toThrow("merge evidence");
  });

  test("migrates legacy awaiting-review to internal complete without inventing Lucy approval", () => {
    const legacy = {
      ...run,
      milestones: [
        {
          ...run.milestones[0],
          status: "awaiting-review",
          checkpointSha: "f".repeat(40),
          pullRequestUrl: "https://github.com/owner/repo/pull/1",
        },
        run.milestones[1],
      ],
    };
    const decoded = decodeStudioRunsFile({ version: 1, runs: [legacy] }).runs[0];
    expect(decoded.milestones[0].status).toBe("complete");
    expect(decoded.milestones[0].githubCheckpoints).toBeUndefined();
  });

  test("makes only dependency-ready queued milestones dispatchable", () => {
    expect(availableStudioMilestones(run).map(({ id }) => id)).toEqual(["m1"]);
    const started = transitionStudioMilestone(run, "m1", "running");
    expect(availableStudioMilestones(started)).toEqual([]);
    const verifying = transitionStudioMilestone(started, "m1", "verifying");
    const completed = transitionStudioMilestone(verifying, "m1", "complete");
    expect(availableStudioMilestones(completed).map(({ id }) => id)).toEqual(["m2"]);
  });

  test("gates dispatch while paused and does not allow premature completion", () => {
    const paused = transitionStudioRun(run, "paused");
    expect(availableStudioMilestones(paused)).toEqual([]);
    expect(() => transitionStudioRun(run, "completed")).toThrow("milestones remain unfinished");
    const stopped = transitionStudioRun(run, "stopped");
    expect(stopped.milestones.map(({ status }) => status)).toEqual(["cancelled", "cancelled"]);
    expect(() => transitionStudioRun(stopped, "running")).toThrow("terminal");
  });

  test("records a durable live correction as a new specification revision", () => {
    const updated = recordStudioCorrection(run, {
      id: "correction-1",
      instruction: "Add a regression case to the acceptance criteria.",
      affectedMilestoneIds: ["m1"],
      now: "2026-09-29T00:00:00.000Z",
    });
    expect(updated).toMatchObject({
      revision: 2,
      specificationRevision: 2,
      corrections: [
        {
          id: "correction-1",
          specificationRevision: 2,
          instruction: "Add a regression case to the acceptance criteria.",
          affectedMilestoneIds: ["m1"],
          status: "prepared",
        },
      ],
    });
    expect(decodeStudioRunsFile({ version: 1, runs: [updated] }).runs[0]).toEqual(updated);
    expect(() => recordStudioCorrection(run, { id: "bad", instruction: "  " })).toThrow(
      "cannot be empty",
    );
    expect(() =>
      recordStudioCorrection(run, {
        id: "bad-target",
        instruction: "Change a missing milestone.",
        affectedMilestoneIds: ["missing"],
      }),
    ).toThrow("unknown milestone");
    expect(() =>
      decodeStudioRunsFile({
        version: 1,
        runs: [{ ...updated, specificationRevision: 3 }],
      }),
    ).toThrow("revision sequence");
  });

  test("rejects unknown persisted keys and invalid dependency references", () => {
    const file = { version: 1, runs: [run] };
    expect(decodeStudioRunsFile(file).runs).toEqual([
      { ...run, specificationRevision: 1, corrections: [] },
    ]);
    expect(() => decodeStudioRunsFile({ ...file, surprise: true })).toThrow(
      "Invalid studio-runs.surprise",
    );
    expect(() =>
      decodeStudioRunsFile({
        version: 1,
        runs: [{ ...run, milestones: [{ ...run.milestones[0], dependsOn: ["missing"] }] }],
      }),
    ).toThrow("milestones dependencies");
    expect(() =>
      decodeStudioRunsFile({
        version: 1,
        runs: [
          {
            ...run,
            milestones: [
              { ...run.milestones[0], dependsOn: ["m2"] },
              { ...run.milestones[1], dependsOn: ["m1"] },
            ],
          },
        ],
      }),
    ).toThrow("dependency cycle");
  });
});
