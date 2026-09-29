import { expect, test } from "@playwright/test";
import {
  availableStudioMilestones,
  applyStudioGitHubPullRequestObservation,
  preserveStudioRunHistory,
  recoverStudioRunsAfterRestart,
  recordStudioGitHubCheckpoint,
  recordStudioGitHubReview,
  recordStudioCorrection,
  isStudioMilestoneDependencySatisfied,
  studioExternalReviewStatus,
  transitionStudioMilestone,
  transitionStudioRun,
  type StudioMilestone,
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
      deliveryRequirement: "github-pr",
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
      deliveryRequirement: "github-pr",
      updatedAt: "2026-09-28T00:00:00.000Z",
    },
  ],
};

test.describe("Studio run plan state", () => {
  test("keeps internal completion separate from SHA-bound Lucy review history", () => {
    const baseSha = "a".repeat(40);
    const firstSha = "b".repeat(40);
    const secondSha = "c".repeat(40);
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
    const duplicateReview = recordStudioGitHubReview(milestone, {
      headSha: firstSha,
      decision: "accepted",
      now: "2026-09-29T00:01:30.000Z",
    });
    expect(duplicateReview).toBe(milestone);
    expect(duplicateReview.githubCheckpoints?.[0].reviewHistory).toHaveLength(1);

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
    expect(
      recordStudioGitHubCheckpoint(milestone, {
        repository: "owner/repo",
        branch: "studio/m1",
        pullRequestUrl: "https://github.com/owner/repo/pull/12",
        baseSha,
        headSha: secondSha,
        pushedAt: "2026-09-29T00:02:00.000Z",
      }),
    ).toBe(milestone);
    expect(() =>
      recordStudioGitHubReview(milestone, { headSha: "e".repeat(40), decision: "accepted" }),
    ).toThrow("exactly recorded");
  });

  test("generic saves reject forged review/merge evidence and immutable-history edits", () => {
    const [baseMilestone] = run.milestones;
    const headSha = "b".repeat(40);
    const milestone = recordStudioGitHubReview(
      recordStudioGitHubCheckpoint(baseMilestone, {
        repository: "owner/repo",
        branch: "studio/m1",
        pullRequestUrl: "https://github.com/owner/repo/pull/12",
        baseSha: "a".repeat(40),
        headSha,
        pushedAt: "2026-09-29T00:00:00.000Z",
      }),
      { headSha, decision: "accepted", now: "2026-09-29T00:01:00.000Z" },
    );
    const current = { ...run, milestones: [milestone, run.milestones[1]] };
    const forged = {
      ...run,
      milestones: [
        {
          ...baseMilestone,
          checkpointSha: headSha,
          pullRequestUrl: "https://github.com/owner/repo/pull/12",
          githubCheckpoints: [
            {
              repository: "owner/repo",
              branch: "studio/m1",
              pullRequestUrl: "https://github.com/owner/repo/pull/12",
              baseSha: "a".repeat(40),
              headSha,
              pushedAt: "2026-09-29T00:00:00.000Z",
              reviewHistory: [
                {
                  decision: "accepted" as const,
                  reviewedHeadSha: headSha,
                  recordedAt: "2026-09-29T00:01:00.000Z",
                  source: "matthew-confirmed-lucy" as const,
                },
              ],
            },
          ],
        },
        run.milestones[1],
      ],
    };
    expect(() => preserveStudioRunHistory(undefined, forged)).toThrow("authorised confirmation");
    expect(() =>
      preserveStudioRunHistory(current, {
        ...current,
        milestones: [
          {
            ...baseMilestone,
            githubCheckpoints: [
              {
                ...milestone.githubCheckpoints![0]!,
                reviewHistory: [
                  {
                    decision: "merged",
                    reviewedHeadSha: headSha,
                    recordedAt: "2026-09-29T00:02:00.000Z",
                    source: "github-api",
                    mergeCommitSha: "d".repeat(40),
                    mergedAt: "2026-09-29T00:02:00.000Z",
                  },
                ],
              },
            ],
          },
          current.milestones[1],
        ],
      }),
    ).toThrow("review history cannot be deleted or rewritten");
    expect(() =>
      preserveStudioRunHistory(current, { ...current, milestones: [milestone] }),
    ).toThrow("cannot be removed");
    expect(() =>
      preserveStudioRunHistory(current, {
        ...current,
        milestones: [{ ...milestone, dependsOn: ["m2"] }, current.milestones[1]],
      }),
    ).toThrow("identities and dependencies are immutable");
    expect(() =>
      preserveStudioRunHistory(current, {
        ...current,
        milestones: [{ ...milestone, githubCheckpoints: undefined }, current.milestones[1]],
      }),
    ).toThrow("cannot be deleted");
    expect(() =>
      preserveStudioRunHistory(current, {
        ...current,
        milestones: [
          {
            ...milestone,
            githubCheckpoints: milestone.githubCheckpoints?.map((checkpoint) => ({
              ...checkpoint,
              baseSha: "f".repeat(40),
            })),
          },
          current.milestones[1],
        ],
      }),
    ).toThrow("identity is immutable");
    expect(() =>
      preserveStudioRunHistory(current, {
        ...current,
        milestones: [
          {
            ...milestone,
            githubCheckpoints: milestone.githubCheckpoints?.map((checkpoint) => ({
              ...checkpoint,
              reviewHistory: checkpoint.reviewHistory.map((review) => ({
                ...review,
                decision: "changes-requested" as const,
              })),
            })),
          },
          current.milestones[1],
        ],
      }),
    ).toThrow("cannot be deleted or rewritten");
    expect(() =>
      preserveStudioRunHistory(current, {
        ...current,
        milestones: [milestone, { ...current.milestones[1]!, dependsOn: [] }],
      }),
    ).toThrow("identities and dependencies are immutable");
    expect(() =>
      preserveStudioRunHistory(
        {
          ...current,
          milestones: [{ ...milestone, deliveryRequirement: "github-pr" }, current.milestones[1]!],
        },
        {
          ...current,
          milestones: [{ ...milestone, deliveryRequirement: "local" }, current.milestones[1]!],
        },
      ),
    ).toThrow("identities and dependencies are immutable");
  });

  test("legacy forged acceptance and merge claims remain readable but untrusted", () => {
    const headSha = "b".repeat(40);
    const legacyRun = {
      ...run,
      milestones: [
        {
          ...run.milestones[0],
          githubCheckpoints: [
            {
              repository: "owner/repo",
              branch: "studio/m1",
              pullRequestUrl: "https://github.com/owner/repo/pull/12",
              baseSha: "a".repeat(40),
              headSha,
              pushedAt: "2026-09-29T00:00:00.000Z",
              reviewHistory: [
                {
                  decision: "merged",
                  reviewedHeadSha: headSha,
                  recordedAt: "2026-09-29T00:01:00.000Z",
                  source: "github-api",
                  mergeCommitSha: "c".repeat(40),
                  mergedAt: "2026-09-29T00:01:00.000Z",
                },
                {
                  decision: "accepted",
                  reviewedHeadSha: headSha,
                  recordedAt: "2026-09-29T00:02:00.000Z",
                  source: "matthew",
                },
              ],
            },
          ],
        },
        run.milestones[1],
      ],
    };
    const decoded = decodeStudioRunsFile({ version: 1, runs: [legacyRun] }).runs[0];
    expect(() => preserveStudioRunHistory(undefined, legacyRun)).toThrow("authorised confirmation");
    const migrated = decoded.milestones[0];
    expect(migrated.githubCheckpoints?.[0].reviewHistory.map(({ source }) => source)).toEqual([
      "legacy-unverified",
      "legacy-unverified",
    ]);
    expect(studioExternalReviewStatus(migrated, headSha)).toBe("awaiting-lucy");
    const verifiedAfterLegacyClaim = applyStudioGitHubPullRequestObservation(migrated, {
      repository: "owner/repo",
      branch: "studio/m1",
      pullRequestUrl: "https://github.com/owner/repo/pull/12",
      baseSha: "a".repeat(40),
      headSha,
      observedAt: "2026-09-29T00:03:00.000Z",
      merged: true,
      mergeCommitSha: "c".repeat(40),
      mergedAt: "2026-09-29T00:01:00.000Z",
    });
    expect(studioExternalReviewStatus(verifiedAfterLegacyClaim, headSha)).toBe("merged");
    expect(() =>
      preserveStudioRunHistory(decoded, {
        ...decoded,
        milestones: [{ ...migrated, githubCheckpoints: [] }, decoded.milestones[1]],
      }),
    ).toThrow("cannot be deleted");
  });

  test("records only direct GitHub merge observations and makes refresh idempotent", () => {
    const headSha = "b".repeat(40);
    const checkpoint = recordStudioGitHubCheckpoint(run.milestones[0]!, {
      repository: "owner/repo",
      branch: "studio/m1",
      pullRequestUrl: "https://github.com/owner/repo/pull/12",
      baseSha: "a".repeat(40),
      headSha,
      pushedAt: "2026-09-29T00:00:00.000Z",
    });
    const observation = {
      repository: "owner/repo",
      branch: "studio/m1",
      pullRequestUrl: "https://github.com/owner/repo/pull/12",
      baseSha: "a".repeat(40),
      headSha,
      observedAt: "2026-09-29T00:02:00.000Z",
      merged: true,
      mergeCommitSha: "c".repeat(40),
      mergedAt: "2026-09-29T00:01:00.000Z",
    };
    const merged = applyStudioGitHubPullRequestObservation(checkpoint, observation);
    expect(studioExternalReviewStatus(merged, headSha)).toBe("merged");
    expect(merged.githubCheckpoints?.[0]?.reviewHistory.at(-1)).toMatchObject({
      source: "github-api",
      decision: "merged",
      mergeCommitSha: observation.mergeCommitSha,
      observedAt: observation.observedAt,
    });
    const persisted = decodeStudioRunsFile({
      version: 1,
      runs: [{ ...run, milestones: [merged, run.milestones[1]] }],
    }).runs[0]!;
    expect(studioExternalReviewStatus(persisted.milestones[0]!, headSha)).toBe("merged");
    expect(() =>
      preserveStudioRunHistory(
        { ...run, milestones: [checkpoint, run.milestones[1]] },
        { ...run, milestones: [merged, run.milestones[1]] },
      ),
    ).toThrow("authorised confirmation");
    expect(applyStudioGitHubPullRequestObservation(merged, observation)).toBe(merged);
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

  test("decodes deliveryRequirement and rejects invalid delivery values", () => {
    const valid = decodeStudioRunsFile({
      version: 1,
      runs: [
        {
          ...run,
          milestones: [
            { ...run.milestones[0]!, deliveryRequirement: "github-pr" },
            { ...run.milestones[1]!, deliveryRequirement: "local" },
          ],
        },
      ],
    }).runs[0]!;
    expect(valid.milestones[0]!.deliveryRequirement).toBe("github-pr");
    expect(valid.milestones[1]!.deliveryRequirement).toBe("local");

    expect(() =>
      decodeStudioRunsFile({
        version: 1,
        runs: [
          {
            ...run,
            milestones: [
              { ...run.milestones[0]!, deliveryRequirement: "invalid-delivery" },
              run.milestones[1]!,
            ],
          },
        ],
      }),
    ).toThrow("Invalid runs[0].milestones[0].deliveryRequirement");
  });

  test("makes only dependency-ready queued milestones dispatchable", () => {
    const localRun: StudioRun = {
      ...run,
      milestones: run.milestones.map((m) => ({ ...m, deliveryRequirement: "local" as const })),
    };
    expect(availableStudioMilestones(localRun).map(({ id }) => id)).toEqual(["m1"]);
    const started = transitionStudioMilestone(localRun, "m1", "running");
    expect(availableStudioMilestones(started)).toEqual([]);
    const verifying = transitionStudioMilestone(started, "m1", "verifying");
    const completed = transitionStudioMilestone(verifying, "m1", "complete");
    expect(availableStudioMilestones(completed).map(({ id }) => id)).toEqual(["m2"]);
  });

  test("gates dependent milestones on PR merge while allowing unaffected work during Lucy review", () => {
    const baseSha = "a".repeat(40);
    const headSha = "b".repeat(40);
    const mergeSha = "c".repeat(40);
    const runWithIndependent: StudioRun = {
      ...run,
      milestones: [
        {
          ...run.milestones[0]!,
          deliveryRequirement: "github-pr",
        },
        run.milestones[1]!,
        {
          id: "m3",
          title: "Independent tooling",
          instruction: "Setup independent fixtures",
          dependsOn: [],
          status: "queued",
          workerThreadIds: [],
          worktreeIds: [],
          updatedAt: "2026-09-28T00:00:00.000Z",
        },
      ],
    };

    // 1. M1 locally complete, PR not yet created: dependent M2 is blocked; independent M3 is available
    const m1Complete = transitionStudioMilestone(
      transitionStudioMilestone(
        transitionStudioMilestone(runWithIndependent, "m1", "running"),
        "m1",
        "verifying",
      ),
      "m1",
      "complete",
    );
    expect(availableStudioMilestones(m1Complete).map(({ id }) => id)).toEqual(["m3"]);

    // 2. M1 awaiting Lucy review (PR checkpoint recorded): M2 is blocked; independent M3 remains available
    const m1WithPr = recordStudioGitHubCheckpoint(m1Complete.milestones[0]!, {
      repository: "owner/repo",
      branch: "studio/m1",
      pullRequestUrl: "https://github.com/owner/repo/pull/12",
      baseSha,
      headSha,
      pushedAt: "2026-09-29T00:00:00.000Z",
    });
    const runAwaitingLucy: StudioRun = {
      ...m1Complete,
      milestones: [m1WithPr, m1Complete.milestones[1]!, m1Complete.milestones[2]!],
      revision: m1Complete.revision + 1,
    };
    expect(preserveStudioRunHistory(m1Complete, runAwaitingLucy)).toBeTruthy();
    expect(availableStudioMilestones(runAwaitingLucy).map(({ id }) => id)).toEqual(["m3"]);

    // 3. Actual GitHub merge observation recorded on M1: dependent M2 becomes available alongside M3
    const observation = {
      repository: "owner/repo",
      branch: "studio/m1",
      pullRequestUrl: "https://github.com/owner/repo/pull/12",
      baseSha,
      headSha,
      observedAt: "2026-09-29T00:10:00.000Z",
      merged: true,
      mergeCommitSha: mergeSha,
      mergedAt: "2026-09-29T00:10:00.000Z",
    };
    const m1Merged = applyStudioGitHubPullRequestObservation(m1WithPr, observation);
    const runMerged: StudioRun = {
      ...runAwaitingLucy,
      milestones: [m1Merged, runAwaitingLucy.milestones[1]!, runAwaitingLucy.milestones[2]!],
      revision: runAwaitingLucy.revision + 1,
    };
    expect(preserveStudioRunHistory(runAwaitingLucy, runMerged, "github-observer")).toBeTruthy();
    expect(availableStudioMilestones(runMerged).map(({ id }) => id)).toEqual(["m2", "m3"]);

    // 4. Explicitly local-only milestones: normal local dependency progression remains possible
    const localRun: StudioRun = {
      ...runWithIndependent,
      milestones: [
        {
          ...runWithIndependent.milestones[0]!,
          deliveryRequirement: "local",
        },
        runWithIndependent.milestones[1]!,
        runWithIndependent.milestones[2]!,
      ],
    };
    const localM1Complete = transitionStudioMilestone(
      transitionStudioMilestone(
        transitionStudioMilestone(localRun, "m1", "running"),
        "m1",
        "verifying",
      ),
      "m1",
      "complete",
    );
    expect(availableStudioMilestones(localM1Complete).map(({ id }) => id)).toEqual(["m2", "m3"]);
  });

  test("omitted delivery requirements block dispatch in autonomous workflow and are rejected for new plans", () => {
    // 1. Omitted delivery requirement in autonomous workflow: local completion does not unlock dependent
    const omittedRun: StudioRun = {
      ...run,
      milestones: [
        { ...run.milestones[0]!, deliveryRequirement: undefined },
        { ...run.milestones[1]!, deliveryRequirement: undefined },
      ],
    };
    const started = transitionStudioMilestone(omittedRun, "m1", "running");
    const verifying = transitionStudioMilestone(started, "m1", "verifying");
    const completed = transitionStudioMilestone(verifying, "m1", "complete");
    // Missing requirement is NOT silently treated as local-only: m2 is blocked!
    expect(availableStudioMilestones(completed)).toEqual([]);

    // 2. Newly planned run requires deliveryRequirement on every milestone
    expect(() => preserveStudioRunHistory(undefined, omittedRun)).toThrow(
      "Every newly planned milestone must declare a delivery requirement",
    );

    // 3. Appending a milestone without deliveryRequirement is rejected
    expect(() =>
      preserveStudioRunHistory(run, {
        ...run,
        milestones: [
          ...run.milestones,
          {
            id: "m3",
            title: "M3",
            instruction: "Do M3",
            dependsOn: [],
            status: "queued",
            workerThreadIds: [],
            worktreeIds: [],
            updatedAt: "2026-09-28T00:00:00.000Z",
          },
        ],
      }),
    ).toThrow("Every newly planned milestone must declare a delivery requirement");

    // 4. Legacy compatibility: legacy runs with omitted deliveryRequirement decode safely
    const legacy = {
      ...run,
      milestones: [
        {
          id: "m1",
          title: "M1",
          instruction: "Do M1",
          dependsOn: [],
          status: "complete",
          workerThreadIds: [],
          worktreeIds: [],
          updatedAt: "2026-09-28T00:00:00.000Z",
        },
      ],
    };
    const decoded = decodeStudioRunsFile({ version: 1, runs: [legacy] }).runs[0]!;
    expect(decoded.milestones[0]!.id).toBe("m1");
    // Legacy milestone without PR metadata resolves to "local", allowing completed work to be resumed
    expect(decoded.milestones[0]!.deliveryRequirement).toBe("local");
    expect(isStudioMilestoneDependencySatisfied(decoded.milestones[0]!)).toBe(true);

    // Legacy milestone with PR metadata migrates to "github-pr" and requires merge evidence
    const legacyWithPr = {
      ...run,
      milestones: [
        {
          id: "m1",
          title: "M1",
          instruction: "Do M1",
          dependsOn: [],
          status: "complete",
          pullRequestUrl: "https://github.com/org/repo/pull/1",
          workerThreadIds: [],
          worktreeIds: [],
          updatedAt: "2026-09-28T00:00:00.000Z",
        },
      ],
    };
    const decodedWithPr = decodeStudioRunsFile({ version: 1, runs: [legacyWithPr] }).runs[0]!;
    expect(decodedWithPr.milestones[0]!.deliveryRequirement).toBe("github-pr");
    expect(isStudioMilestoneDependencySatisfied(decodedWithPr.milestones[0]!)).toBe(false);

    // A milestone with undefined deliveryRequirement never bypasses merge in autonomous workflow
    expect(
      isStudioMilestoneDependencySatisfied({
        ...legacy.milestones[0],
        deliveryRequirement: undefined,
      }),
    ).toBe(false);
  });

  test("rejects conflicting local and GitHub PR states and prevents bypass", () => {
    const headSha = "b".repeat(40);
    const baseSha = "a".repeat(40);
    const localMilestoneWithPr: StudioMilestone = {
      id: "m1",
      title: "Local task",
      instruction: "Local instructions",
      dependsOn: [],
      status: "complete",
      workerThreadIds: [],
      worktreeIds: [],
      deliveryRequirement: "local",
      pullRequestUrl: "https://github.com/owner/repo/pull/42",
      updatedAt: "2026-09-28T00:00:00.000Z",
    };

    // 1. decodeStudioRunsFile rejects contradictory state
    expect(() =>
      decodeStudioRunsFile({
        version: 1,
        runs: [{ ...run, milestones: [localMilestoneWithPr] }],
      }),
    ).toThrow("Contradictory milestone delivery requirement");

    // 2. preserveStudioRunHistory rejects contradictory state on new run
    expect(() =>
      preserveStudioRunHistory(undefined, { ...run, milestones: [localMilestoneWithPr] }),
    ).toThrow("Contradictory milestone delivery requirement");

    // 3. recordStudioGitHubCheckpoint rejects recording PR checkpoint for local-only milestone
    expect(() =>
      recordStudioGitHubCheckpoint(
        { ...run.milestones[0]!, deliveryRequirement: "local" },
        {
          repository: "owner/repo",
          branch: "studio/local",
          pullRequestUrl: "https://github.com/owner/repo/pull/42",
          baseSha,
          headSha,
          pushedAt: "2026-09-28T00:00:00.000Z",
        },
      ),
    ).toThrow("Cannot record a GitHub checkpoint for a local-only milestone");

    // 4. isStudioMilestoneDependencySatisfied never bypasses merge verification if PR URL exists on local milestone
    expect(isStudioMilestoneDependencySatisfied(localMilestoneWithPr)).toBe(false);
  });

  test("rejects attempted delivery requirement changes on existing milestones", () => {
    const currentRun: StudioRun = {
      ...run,
      milestones: [{ ...run.milestones[0]!, deliveryRequirement: "github-pr" }, run.milestones[1]!],
    };

    // Changing from github-pr to local
    expect(() =>
      preserveStudioRunHistory(currentRun, {
        ...currentRun,
        milestones: [
          { ...currentRun.milestones[0]!, deliveryRequirement: "local" },
          currentRun.milestones[1]!,
        ],
      }),
    ).toThrow("Existing Studio milestone identities and dependencies are immutable");

    // Changing from local to github-pr
    const localRun: StudioRun = {
      ...run,
      milestones: [{ ...run.milestones[0]!, deliveryRequirement: "local" }, run.milestones[1]!],
    };
    expect(() =>
      preserveStudioRunHistory(localRun, {
        ...localRun,
        milestones: [
          { ...localRun.milestones[0]!, deliveryRequirement: "github-pr" },
          localRun.milestones[1]!,
        ],
      }),
    ).toThrow("Existing Studio milestone identities and dependencies are immutable");
  });

  test("gates dispatch while paused and does not allow premature completion", () => {
    const paused = transitionStudioRun(run, "paused");
    expect(availableStudioMilestones(paused)).toEqual([]);
    expect(() => transitionStudioRun(run, "completed")).toThrow("milestones remain unfinished");
    const stopped = transitionStudioRun(run, "stopped");
    expect(stopped.milestones.map(({ status }) => status)).toEqual(["cancelled", "cancelled"]);
    expect(() => transitionStudioRun(stopped, "running")).toThrow("terminal");
  });

  test("treats the host-owned run delivery policy as immutable and decodable", () => {
    const localRun: StudioRun = { ...run, deliveryPolicy: "local" };
    expect(decodeStudioRunsFile({ version: 1, runs: [localRun] }).runs[0]).toEqual({
      ...localRun,
      specificationRevision: 1,
      corrections: [],
    });
    expect(() =>
      decodeStudioRunsFile({ version: 1, runs: [{ ...run, deliveryPolicy: "hostile" }] }),
    ).toThrow("deliveryPolicy");
    // A later save cannot flip an authorised local-only run to GitHub delivery…
    expect(() =>
      preserveStudioRunHistory(localRun, { ...localRun, deliveryPolicy: "github-pr" }),
    ).toThrow("delivery policy is host-owned and immutable");
    // …and cannot silently upgrade a GitHub-delivery run to local-only.
    expect(() => preserveStudioRunHistory(run, { ...run, deliveryPolicy: "local" })).toThrow(
      "delivery policy is host-owned and immutable",
    );
    // Omitting the field preserves the effective default policy.
    expect(preserveStudioRunHistory(localRun, { ...localRun }).deliveryPolicy).toBe("local");
    expect(preserveStudioRunHistory(run, { ...run }).deliveryPolicy).toBeUndefined();
  });

  test("lets a run complete when remaining milestones are terminally cancelled", () => {
    const cancelled = transitionStudioMilestone(run, "m2", "cancelled");
    const completedM1 = transitionStudioMilestone(
      transitionStudioMilestone(
        transitionStudioMilestone(cancelled, "m1", "running"),
        "m1",
        "verifying",
      ),
      "m1",
      "complete",
    );
    const finished = transitionStudioRun(completedM1, "completed");
    expect(finished.status).toBe("completed");
    expect(finished.milestones.map(({ status }) => status)).toEqual(["complete", "cancelled"]);
  });

  test("restart recovery pauses only running plans and is safe to repeat", () => {
    const untouched = { ...run, status: "draft" as const };
    const recovered = recoverStudioRunsAfterRestart([run, untouched], "2026-09-29T01:00:00.000Z");
    expect(recovered[0]).toMatchObject({
      status: "paused",
      revision: run.revision + 1,
      updatedAt: "2026-09-29T01:00:00.000Z",
      lastError: expect.stringContaining("Restart recovery required"),
    });
    expect(availableStudioMilestones(recovered[0]!)).toEqual([]);
    expect(recovered[1]).toBe(untouched);
    expect(recoverStudioRunsAfterRestart(recovered)).toBe(recovered);
    expect(transitionStudioRun(recovered[0]!, "running")).not.toHaveProperty("lastError");
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

  test("model saves cannot create or rewrite Matthew correction history", () => {
    const prepared = recordStudioCorrection(run, {
      id: "correction-1",
      instruction: "Add a recovery check to the remaining work.",
      affectedMilestoneIds: ["m2"],
      now: "2026-09-29T00:00:00.000Z",
    });
    expect(() => preserveStudioRunHistory(run, prepared)).toThrow("authorised UI path");
    expect(preserveStudioRunHistory(run, prepared, "matthew-correction").corrections).toEqual(
      prepared.corrections,
    );
    expect(() =>
      preserveStudioRunHistory(prepared, {
        ...prepared,
        corrections: [],
        specificationRevision: 1,
      }),
    ).toThrow("cannot be deleted");
    expect(() =>
      preserveStudioRunHistory(prepared, {
        ...prepared,
        corrections: [
          { ...prepared.corrections![0]!, instruction: "Replace the original request." },
        ],
      }),
    ).toThrow("history is immutable");
    expect(() =>
      preserveStudioRunHistory(prepared, {
        ...prepared,
        corrections: [{ ...prepared.corrections![0]!, status: "applied" }],
      }),
    ).toThrow("follow its lifecycle");
    expect(
      preserveStudioRunHistory(prepared, {
        ...prepared,
        corrections: [{ ...prepared.corrections![0]!, status: "sent" }],
      }).corrections?.[0]?.status,
    ).toBe("sent");
    const sent = {
      ...prepared,
      corrections: [{ ...prepared.corrections![0]!, status: "sent" as const }],
    };
    expect(() =>
      preserveStudioRunHistory(sent, {
        ...sent,
        corrections: [{ ...sent.corrections[0]!, status: "applied" }],
      }),
    ).toThrow("reconciliation summary");
    const appliedCorrection = {
      ...sent.corrections[0]!,
      status: "applied" as const,
      reconciliationSummary: "Replanned the remaining two milestones after inspecting active work.",
    };
    expect(() =>
      preserveStudioRunHistory(sent, { ...sent, corrections: [appliedCorrection] }),
    ).toThrow("must be completed or cancelled");
    const reconciled = {
      ...sent,
      corrections: [appliedCorrection],
      milestones: [sent.milestones[0]!, { ...sent.milestones[1]!, status: "cancelled" as const }],
    };
    const applied = preserveStudioRunHistory(sent, reconciled);
    expect(
      decodeStudioRunsFile({ version: 1, runs: [applied] }).runs[0]?.corrections?.[0],
    ).toMatchObject({
      status: "applied",
      reconciliationSummary: "Replanned the remaining two milestones after inspecting active work.",
    });
    expect(() =>
      preserveStudioRunHistory(applied, {
        ...applied,
        corrections: [{ ...applied.corrections![0]!, reconciliationSummary: "Rewrite history." }],
      }),
    ).toThrow("history is immutable");
    const legacyApplied = {
      ...prepared,
      corrections: [{ ...prepared.corrections![0]!, status: "applied" as const }],
    };
    expect(
      decodeStudioRunsFile({ version: 1, runs: [legacyApplied] }).runs[0]?.corrections?.[0]?.status,
    ).toBe("applied");
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
