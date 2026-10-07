# CI checks and merge enforcement

The current `.github/workflows/ci.yml` defines a single `Web CI` job. It runs
`pnpm check` and the website build in sequence. There is no aggregate job, job
matrix, desktop package job, or shard gate in this workflow.

The CI topology tests read the workflow and verify that its `web-ci` job runs
both checks unconditionally. `scripts/check-ci-results.mjs` models the same
single required job result and fails closed for missing, skipped, cancelled, or
failed results. This helper is validated by tests but is not itself a workflow
step; GitHub's `Web CI` check is the workflow status.

Whether GitHub blocks a merge on `Web CI` is controlled by branch protection or
a repository ruleset, separately from this workflow. Inspect the live rules
before treating a green run as enforced merge policy. Do not bypass a failed
check to merge.
