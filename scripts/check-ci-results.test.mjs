import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { checkCiResults, requiredJobs } from "./check-ci-results.mjs";

const passing = () => Object.fromEntries(requiredJobs.map((job) => [job, { result: "success" }]));
const script = fileURLToPath(new URL("./check-ci-results.mjs", import.meta.url));

test("all required jobs must succeed", () => {
  assert.deepEqual(checkCiResults(passing()), []);
  for (const job of requiredJobs) {
    for (const result of ["failure", "cancelled", "skipped", "neutral", "", undefined]) {
      const needs = passing();
      needs[job] = { result };
      const failures = checkCiResults(needs);
      assert.equal(failures.length, 1);
      assert.match(failures[0], new RegExp(`${job}: expected success`));
    }
    const needs = passing();
    delete needs[job];
    assert.equal(checkCiResults(needs).length, 1);
  }
});

test("missing, malformed, or unexpected results fail closed", () => {
  for (const needs of [
    undefined,
    null,
    [],
    "success",
    {},
    { ...passing(), unexpected: { result: "success" } },
  ]) {
    assert.ok(checkCiResults(needs).length > 0);
  }
});

test("CLI exit status reflects the result and rejects invalid JSON", () => {
  for (const [input, status] of [
    [JSON.stringify(passing()), 0],
    ["{}", 1],
    ["not-json", 1],
    ["", 1],
  ]) {
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, CI_NEEDS: input },
      encoding: "utf8",
    });
    assert.equal(result.status, status, result.stderr);
    if (status === 1) assert.ok(result.stderr.length > 0);
  }
});

test("workflow exposes the current Web CI baseline and website build", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  assert.deepEqual(requiredJobs, ["web-ci"]);
  assert.deepEqual(Object.keys(workflow.jobs), requiredJobs);
  const webCi = workflow.jobs["web-ci"];
  assert.equal(webCi.name, "Web CI");
  assert.equal(webCi["runs-on"], "ubuntu-latest");
  assert.ok(Object.hasOwn(workflow["on"], "pull_request"));
  assert.deepEqual(workflow["on"].push.branches, ["main"]);
  assertBaselineRuns(workflow);
  assertWebsiteBuildRuns(workflow);
  assert.ok(webCi["continue-on-error"] === undefined || webCi["continue-on-error"] === false);
  for (const step of webCi.steps) {
    assert.ok(step["continue-on-error"] === undefined || step["continue-on-error"] === false);
  }
});

function assertBaselineRuns(workflow) {
  const baseline = workflow.jobs["web-ci"];
  assert.equal(baseline.if, undefined, "The baseline job must run on every CI invocation");
  const checks = baseline.steps.filter((step) => step.run === "pnpm check");
  assert.equal(checks.length, 1, "CI must run the canonical pnpm check command exactly once");
  assert.equal(checks[0].if, undefined, "The pnpm check step must not be conditional");
  assert.ok(
    checks[0]["continue-on-error"] === undefined || checks[0]["continue-on-error"] === false,
    "A failed baseline must fail CI",
  );
}

test("CI runs the canonical baseline unconditionally", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  assertBaselineRuns(workflow);
  for (const mutate of [
    (copy) => {
      copy.jobs["web-ci"].if = "false";
    },
    (copy) => {
      copy.jobs["web-ci"].steps.find((step) => step.run === "pnpm check").if = "false";
    },
    (copy) => {
      copy.jobs["web-ci"].steps.find((step) => step.run === "pnpm check").run = "echo skipped";
    },
    (copy) => {
      copy.jobs["web-ci"].steps.find((step) => step.run === "pnpm check")["continue-on-error"] =
        true;
    },
  ]) {
    const invalid = structuredClone(workflow);
    mutate(invalid);
    assert.throws(() => assertBaselineRuns(invalid), /baseline|pnpm check/);
  }
});

function assertWebsiteBuildRuns(workflow) {
  const build = workflow.jobs["web-ci"].steps.filter(
    (step) => step.run === "pnpm --filter @pi-gui/website run build",
  );
  assert.equal(build.length, 1, "CI must build the website exactly once");
  assert.equal(build[0].if, undefined, "The website build must not be conditional");
}
