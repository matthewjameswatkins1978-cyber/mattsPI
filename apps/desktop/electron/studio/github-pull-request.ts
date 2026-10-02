import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { StudioGitHubPullRequestObservation } from "../../contracts/studio-runs";

const execFileAsync = promisify(execFile);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`GitHub response is missing ${label}.`);
  return value.trim();
}

function fullSha(value: unknown, label: string): string {
  const sha = requiredText(value, label);
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(sha))
    throw new Error(`GitHub response has an invalid ${label}.`);
  return sha;
}

export function githubPullRequestApiPath(pullRequestUrl: string): string {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/.exec(
      pullRequestUrl,
    );
  if (!match) throw new Error("Studio can refresh only a GitHub pull request URL.");
  return `repos/${match[1]}/${match[2]}/pulls/${match[3]}`;
}

export function parseStudioGitHubPullRequest(
  pullRequestUrl: string,
  value: unknown,
  observedAt = new Date().toISOString(),
): StudioGitHubPullRequestObservation {
  const apiPath = githubPullRequestApiPath(pullRequestUrl);
  if (!object(value) || !object(value.base) || !object(value.head)) {
    throw new Error("GitHub returned an incomplete pull request record.");
  }
  const url = requiredText(value.html_url, "pull request URL").replace(/\/$/, "");
  if (url.toLowerCase() !== pullRequestUrl.replace(/\/$/, "").toLowerCase()) {
    throw new Error("GitHub returned a different pull request than the saved checkpoint.");
  }
  const repository = apiPath.split("/").slice(1, 3).join("/");
  if (typeof value.merged !== "boolean") throw new Error("GitHub response is missing merge state.");
  if (value.state !== "open" && value.state !== "closed") {
    throw new Error("GitHub response is missing pull request state.");
  }
  if (value.merged && value.state !== "closed") {
    throw new Error("GitHub returned an inconsistent merged pull request state.");
  }
  const mergeCommitSha = value.merge_commit_sha;
  const mergedAt = value.merged_at;
  if (value.merged && (typeof mergeCommitSha !== "string" || typeof mergedAt !== "string")) {
    throw new Error("GitHub marked the pull request merged without merge commit evidence.");
  }
  return {
    repository,
    branch: requiredText(value.head.ref, "head branch"),
    pullRequestUrl: url,
    baseSha: fullSha(value.base.sha, "base SHA"),
    headSha: fullSha(value.head.sha, "head SHA"),
    observedAt,
    merged: value.merged,
    ...(value.merged
      ? {
          mergeCommitSha: fullSha(mergeCommitSha, "merge commit SHA"),
          mergedAt: requiredText(mergedAt, "merged time"),
        }
      : {}),
  };
}

/** Reads one PR through the user's authenticated GitHub CLI; it never writes or merges. */
export async function readStudioGitHubPullRequest(
  repositoryPath: string,
  pullRequestUrl: string,
  observedAt = new Date().toISOString(),
): Promise<StudioGitHubPullRequestObservation> {
  const endpoint = githubPullRequestApiPath(pullRequestUrl);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("gh", ["api", endpoint], {
      cwd: repositoryPath,
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    }));
  } catch {
    throw new Error(
      "Could not read this pull request with the signed-in GitHub CLI. Check gh login and repository access.",
    );
  }
  let response: unknown;
  try {
    response = JSON.parse(stdout);
  } catch {
    throw new Error("GitHub CLI returned an unreadable pull request response.");
  }
  return parseStudioGitHubPullRequest(pullRequestUrl, response, observedAt);
}
