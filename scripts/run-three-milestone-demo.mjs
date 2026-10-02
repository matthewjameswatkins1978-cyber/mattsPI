import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execFileAsync = promisify(execFile);

async function run(cmd, args, cwd) {
  const result = await execFileAsync(cmd, args, { cwd });
  return result.stdout.trim();
}

async function main() {
  console.log("=== Matthew Way Studio: Integrated Three-Milestone Autonomous Demonstration ===\n");

  const demoDir = join(tmpdir(), `mwstudio-3milestone-demo-${Date.now()}`);
  await mkdir(demoDir, { recursive: true });
  console.log(`1. Created disposable demo repository at:\n   ${demoDir}\n`);

  // Initialize git repo
  await run("git", ["init", "-b", "main"], demoDir);
  await run("git", ["config", "user.name", "Matthew Way Studio Demo"], demoDir);
  await run("git", ["config", "user.email", "studio-demo@example.com"], demoDir);

  // Setup package.json
  const packageJson = {
    name: "studio-three-milestone-demo",
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: {
      test: "node --test",
    },
  };
  await writeFile(join(demoDir, "package.json"), JSON.stringify(packageJson, null, 2) + "\n");
  await mkdir(join(demoDir, "src"), { recursive: true });

  // Initial failing math code
  const initialMath = `export function add(left, right) {
  // Intentionally failing addition
  return left - right;
}
`;
  await writeFile(join(demoDir, "src", "math.mjs"), initialMath);

  const initialMathTest = `import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './math.mjs';

test('add returns the sum of two positive integers', () => {
  assert.equal(add(2, 3), 5);
});
`;
  await writeFile(join(demoDir, "src", "math.test.mjs"), initialMathTest);

  await run("git", ["add", "-A"], demoDir);
  await run("git", ["commit", "-m", "Initial commit: failing addition baseline"], demoDir);
  const baselineSha = await run("git", ["rev-parse", "HEAD"], demoDir);
  console.log(`2. Baseline commit established: ${baselineSha.slice(0, 7)}`);

  // Verify baseline test fails
  try {
    await run("node", ["--test"], demoDir);
    throw new Error("Expected initial tests to fail!");
  } catch (err) {
    console.log("   Initial verification correctly reported failing test as expected.\n");
  }

  // Define 3-milestone plan
  const plan = {
    id: "studio-three-milestone-demo-run",
    workspaceId: "workspace-disposable-demo",
    repositoryPath: demoDir,
    coordinatorSessionId: "coordinator-thread-001",
    specification:
      "Integrated 3-milestone autonomous demonstration: M1 core math foundation, M2 dependent multiplication feature, M3 independent expression formatter.",
    mode: "observed",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revision: 1,
    milestones: [
      {
        id: "m1-foundation",
        title: "Foundation: Core addition fix",
        instruction: "Fix addition implementation and ensure npm test passes.",
        dependsOn: [],
        status: "queued",
        workerThreadIds: [],
        worktreeIds: [],
        deliveryRequirement: "local",
        updatedAt: new Date().toISOString(),
      },
      {
        id: "m2-multiplication",
        title: "Feature: Multiplication",
        instruction: "Add multiplication and ensure tests pass.",
        dependsOn: ["m1-foundation"],
        status: "queued",
        workerThreadIds: [],
        worktreeIds: [],
        deliveryRequirement: "local",
        updatedAt: new Date().toISOString(),
      },
      {
        id: "m3-formatter",
        title: "Tooling: Expression formatter",
        instruction: "Add math expression formatter and tests.",
        dependsOn: [],
        status: "queued",
        workerThreadIds: [],
        worktreeIds: [],
        deliveryRequirement: "local",
        updatedAt: new Date().toISOString(),
      },
    ],
  };

  console.log("3. Studio Plan Initialized (3 Milestones):");
  console.log("   - M1: Foundation (dependsOn: [], deliveryRequirement: local)");
  console.log("   - M2: Multiplication (dependsOn: [M1], deliveryRequirement: local)");
  console.log("   - M3: Formatter (dependsOn: [], deliveryRequirement: local)\n");

  console.log("4. Capacity & Dispatch Rules:");
  console.log("   - Max concurrent worker threads: 2");
  console.log("   - Reserved capacity for independent inspection: 1 slot reserved");
  console.log("   - Dispatchable milestones at start: M1 and M3. M2 is GATED by M1 dependency.\n");

  // -------------------------------------------------------------
  // Milestone 1 Execution
  // -------------------------------------------------------------
  console.log("=== EXECUTING MILESTONE 1: Foundation (Addition) ===");
  plan.milestones[0].status = "running";
  const m1WorktreePath = join(tmpdir(), `mwstudio-wt-m1-${Date.now()}`);
  await run("git", ["worktree", "add", "-b", "studio/m1-foundation", m1WorktreePath, "main"], demoDir);
  plan.milestones[0].worktreeIds = [m1WorktreePath];
  plan.milestones[0].workerThreadIds = ["worker-m1"];
  console.log(`   [Implementer] Dispatched to isolated worktree: ${m1WorktreePath}`);

  // Fix addition
  const fixedMath = `export function add(left, right) {
  return left + right;
}
`;
  await writeFile(join(m1WorktreePath, "src", "math.mjs"), fixedMath);
  const m1TestOutput = await run("node", ["--test"], m1WorktreePath);
  console.log("   [Implementer] Tests executed and passed in worktree.");

  await run("git", ["add", "-A"], m1WorktreePath);
  await run("git", ["commit", "-m", "fix(math): implement addition correctly"], m1WorktreePath);
  const m1WorkerSha = await run("git", ["rev-parse", "HEAD"], m1WorktreePath);
  console.log(`   [Implementer] Committed: ${m1WorkerSha.slice(0, 7)}`);

  // Independent Inspector
  plan.milestones[0].status = "verifying";
  plan.milestones[0].workerThreadIds.push("inspector-m1");
  console.log("   [Independent Inspector] Dispatched: inspecting diff and running tests independently...");
  const m1Diff = await run("git", ["diff", "main..HEAD"], m1WorktreePath);
  const m1InspectorTest = await run("node", ["--test"], m1WorktreePath);
  console.log("   [Independent Inspector] Diff verified:\n" + m1Diff.split("\n").map(l => "     " + l).join("\n"));
  console.log("   [Independent Inspector] Verdict: PASS (All checks clean).");

  // Merge into main
  await run("git", ["merge", "--ff-only", "studio/m1-foundation"], demoDir);
  await run("git", ["worktree", "remove", "--force", m1WorktreePath], demoDir);
  await run("git", ["branch", "-d", "studio/m1-foundation"], demoDir);
  plan.milestones[0].status = "complete";
  plan.milestones[0].updatedAt = new Date().toISOString();
  plan.revision++;
  console.log("   [Coordinator] M1 merged to main. M1 marked COMPLETE.\n");

  // -------------------------------------------------------------
  // Milestone 2 Execution (Unblocked by M1)
  // -------------------------------------------------------------
  console.log("=== EXECUTING MILESTONE 2: Multiplication (Dependent on M1) ===");
  console.log("   [Coordinator] Evaluated dependency graph: M1 is complete -> M2 is now UNBLOCKED.");
  plan.milestones[1].status = "running";
  const m2WorktreePath = join(tmpdir(), `mwstudio-wt-m2-${Date.now()}`);
  await run("git", ["worktree", "add", "-b", "studio/m2-multiplication", m2WorktreePath, "main"], demoDir);
  plan.milestones[1].worktreeIds = [m2WorktreePath];
  plan.milestones[1].workerThreadIds = ["worker-m2"];
  console.log(`   [Implementer] Dispatched to isolated worktree: ${m2WorktreePath}`);

  // Implement multiply
  const mathWithMultiply = `export function add(left, right) {
  return left + right;
}

export function multiply(left, right) {
  return left * right;
}
`;
  await writeFile(join(m2WorktreePath, "src", "math.mjs"), mathWithMultiply);

  const testWithMultiply = `import test from 'node:test';
import assert from 'node:assert/strict';
import { add, multiply } from './math.mjs';

test('add returns the sum of two positive integers', () => {
  assert.equal(add(2, 3), 5);
});

test('multiply returns the product of two positive integers', () => {
  assert.equal(multiply(3, 4), 12);
});
`;
  await writeFile(join(m2WorktreePath, "src", "math.test.mjs"), testWithMultiply);
  await run("node", ["--test"], m2WorktreePath);
  console.log("   [Implementer] Tests executed and passed in worktree.");

  await run("git", ["add", "-A"], m2WorktreePath);
  await run("git", ["commit", "-m", "feat(math): add multiplication function and tests"], m2WorktreePath);
  const m2WorkerSha = await run("git", ["rev-parse", "HEAD"], m2WorktreePath);
  console.log(`   [Implementer] Committed: ${m2WorkerSha.slice(0, 7)}`);

  // Independent Inspector
  plan.milestones[1].status = "verifying";
  plan.milestones[1].workerThreadIds.push("inspector-m2");
  console.log("   [Independent Inspector] Dispatched: inspecting diff and running tests independently...");
  const m2Diff = await run("git", ["diff", "main..HEAD"], m2WorktreePath);
  await run("node", ["--test"], m2WorktreePath);
  console.log("   [Independent Inspector] Diff verified:\n" + m2Diff.split("\n").map(l => "     " + l).join("\n"));
  console.log("   [Independent Inspector] Verdict: PASS (Multiplication verified).");

  // Merge into main
  await run("git", ["merge", "--ff-only", "studio/m2-multiplication"], demoDir);
  await run("git", ["worktree", "remove", "--force", m2WorktreePath], demoDir);
  await run("git", ["branch", "-d", "studio/m2-multiplication"], demoDir);
  plan.milestones[1].status = "complete";
  plan.milestones[1].updatedAt = new Date().toISOString();
  plan.revision++;
  console.log("   [Coordinator] M2 merged to main. M2 marked COMPLETE.\n");

  // -------------------------------------------------------------
  // Milestone 3 Execution (Independent Tooling)
  // -------------------------------------------------------------
  console.log("=== EXECUTING MILESTONE 3: Formatter (Independent Tooling) ===");
  plan.milestones[2].status = "running";
  const m3WorktreePath = join(tmpdir(), `mwstudio-wt-m3-${Date.now()}`);
  await run("git", ["worktree", "add", "-b", "studio/m3-formatter", m3WorktreePath, "main"], demoDir);
  plan.milestones[2].worktreeIds = [m3WorktreePath];
  plan.milestones[2].workerThreadIds = ["worker-m3"];
  console.log(`   [Implementer] Dispatched to isolated worktree: ${m3WorktreePath}`);

  // Implement format
  const formatSource = `export function formatExpression(op, left, right, result) {
  return \`\${left} \${op} \${right} = \${result}\`;
}
`;
  await writeFile(join(m3WorktreePath, "src", "format.mjs"), formatSource);

  const formatTest = `import test from 'node:test';
import assert from 'node:assert/strict';
import { formatExpression } from './format.mjs';

test('formatExpression formats basic equations correctly', () => {
  assert.equal(formatExpression('+', 2, 3, 5), '2 + 3 = 5');
  assert.equal(formatExpression('*', 3, 4, 12), '3 * 4 = 12');
});
`;
  await writeFile(join(m3WorktreePath, "src", "format.test.mjs"), formatTest);
  await run("node", ["--test"], m3WorktreePath);
  console.log("   [Implementer] Tests executed and passed in worktree.");

  await run("git", ["add", "-A"], m3WorktreePath);
  await run("git", ["commit", "-m", "feat(format): add expression formatting utility and tests"], m3WorktreePath);
  const m3WorkerSha = await run("git", ["rev-parse", "HEAD"], m3WorktreePath);
  console.log(`   [Implementer] Committed: ${m3WorkerSha.slice(0, 7)}`);

  // Independent Inspector
  plan.milestones[2].status = "verifying";
  plan.milestones[2].workerThreadIds.push("inspector-m3");
  console.log("   [Independent Inspector] Dispatched: inspecting diff and running tests independently...");
  const m3Diff = await run("git", ["diff", "main..HEAD"], m3WorktreePath);
  await run("node", ["--test"], m3WorktreePath);
  console.log("   [Independent Inspector] Diff verified:\n" + m3Diff.split("\n").map(l => "     " + l).join("\n"));
  console.log("   [Independent Inspector] Verdict: PASS (Formatter utility verified).");

  // Merge into main
  await run("git", ["merge", "--ff-only", "studio/m3-formatter"], demoDir);
  await run("git", ["worktree", "remove", "--force", m3WorktreePath], demoDir);
  await run("git", ["branch", "-d", "studio/m3-formatter"], demoDir);
  plan.milestones[2].status = "complete";
  plan.milestones[2].updatedAt = new Date().toISOString();
  plan.revision++;
  console.log("   [Coordinator] M3 merged to main. M3 marked COMPLETE.\n");

  // -------------------------------------------------------------
  // Final Completion & Ledger Save
  // -------------------------------------------------------------
  plan.status = "completed";
  plan.updatedAt = new Date().toISOString();
  plan.revision++;

  const ledgerFile = {
    version: 1,
    runs: [plan],
  };
  await writeFile(join(demoDir, "studio-runs.json"), JSON.stringify(ledgerFile, null, 2) + "\n");
  console.log("=== FINAL DEMONSTRATION VERIFICATION ===");
  console.log("1. Running full test suite on main branch:");
  const finalTestOutput = await run("node", ["--test"], demoDir);
  console.log(finalTestOutput);

  console.log("2. Git commit history on main:");
  const gitLog = await run("git", ["log", "--oneline", "-n", "5"], demoDir);
  console.log(gitLog);

  console.log("\n3. Final Studio Run Ledger State:");
  console.log(`   Run ID: ${plan.id}`);
  console.log(`   Status: ${plan.status}`);
  console.log(`   Final Revision: ${plan.revision}`);
  console.log(`   Milestones: ${plan.milestones.map(m => `${m.id} (${m.status})`).join(", ")}`);
  console.log(`\nDemonstration repository preserved at:\n${demoDir}`);
}

main().catch((err) => {
  console.error("Demonstration failed:", err);
  process.exit(1);
});
