import { expect, test } from "@playwright/test";
import {
  githubPullRequestApiPath,
  parseStudioGitHubPullRequest,
} from "../../electron/studio/github-pull-request";

const pullRequestUrl = "https://github.com/owner/repo/pull/12";
const openPullRequest = {
  html_url: pullRequestUrl,
  state: "open",
  merged: false,
  merged_at: null,
  merge_commit_sha: null,
  base: { sha: "a".repeat(40) },
  head: { ref: "studio/m1", sha: "b".repeat(40) },
};

test("builds a fixed GitHub API endpoint from a canonical pull request URL", () => {
  expect(githubPullRequestApiPath(pullRequestUrl)).toBe("repos/owner/repo/pulls/12");
  expect(() => githubPullRequestApiPath("https://github.com.evil.test/owner/repo/pull/12")).toThrow(
    "GitHub pull request URL",
  );
});

test("accepts a matching open pull request and keeps merge metadata absent", () => {
  expect(
    parseStudioGitHubPullRequest(pullRequestUrl, openPullRequest, "2026-09-29T00:02:00.000Z"),
  ).toEqual({
    repository: "owner/repo",
    branch: "studio/m1",
    pullRequestUrl,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    observedAt: "2026-09-29T00:02:00.000Z",
    merged: false,
  });
});

test("rejects mismatched pull requests and unsubstantiated merge responses", () => {
  expect(() =>
    parseStudioGitHubPullRequest(pullRequestUrl, {
      ...openPullRequest,
      html_url: `${pullRequestUrl}3`,
    }),
  ).toThrow("different pull request");
  expect(() =>
    parseStudioGitHubPullRequest(pullRequestUrl, {
      ...openPullRequest,
      state: "closed",
      merged: true,
      merged_at: "2026-09-29T00:01:00.000Z",
      merge_commit_sha: null,
    }),
  ).toThrow("without merge commit evidence");
});
