import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  commitAllInGitRepo,
  getDesktopState,
  launchDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  seedAgentDir,
  writeTextFile,
} from "../helpers/electron-app";
import {
  allText,
  assistantTurnCount,
  messageText,
  pickShellTool,
  scriptedText,
  scriptedToolCall,
  startScriptedOpenAiServer,
  toolExchanges,
  userText,
  type ScriptedActor,
  type ScriptedRequestContext,
  type ScriptedResponse,
} from "../helpers/scripted-openai-provider";

const execFileAsync = promisify(execFile);

/**
 * Real three-milestone Studio run through Pi's native orchestration runtime.
 *
 * Everything below executes on the real Electron surface against a disposable
 * math repository. A deterministic local OpenAI-compatible fixture scripts the
 * model turns, but every tool call is executed natively by Pi: the coordinator
 * is a real session that persists the plan with save_studio_run, dispatches real
 * implementation child threads into managed worktrees with create_child_thread,
 * separate independent-inspector children inspect real Git diffs and run real
 * tests, and the host verification gate and delivery policy control completion.
 *
 * Plan: M1 repair addition; M2 add multiplication (depends on M1);
 * M3 add independent expression formatting.
 */

const SPECIFICATION = [
  "Disposable math project demonstration.",
  "M1: repair addition so the baseline test passes.",
  "M2: add multiplication with tests (depends on M1).",
  "M3: add independent expression formatting with scoped tests.",
].join(" ");

const MILESTONE_PLAN = [
  {
    id: "m1-addition",
    title: "Repair addition",
    instruction:
      "Fix src/math.mjs so add(left, right) returns the sum. The repository test command must pass and the change must be committed on the worker branch.",
    dependsOn: [] as string[],
  },
  {
    id: "m2-multiplication",
    title: "Add multiplication",
    instruction:
      "Extend src/math.mjs with multiply(left, right) and src/math.test.mjs with a multiplication test. The repository test command must pass and the change must be committed on the worker branch.",
    dependsOn: ["m1-addition"],
  },
  {
    id: "m3-formatting",
    title: "Add expression formatting",
    instruction:
      "Add src/format.mjs exporting formatExpression(op, left, right, result) and src/format.test.mjs with scoped tests. The scoped test command must pass and the change must be committed on the worker branch.",
    dependsOn: [] as string[],
  },
] as const;

const BASELINE_MATH = `export function add(left, right) {
  // Intentionally broken baseline: subtracts instead of adding.
  return left - right;
}
`;

const BASELINE_MATH_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './math.mjs';

test('add returns the sum of two positive integers', () => {
  assert.equal(add(2, 3), 5);
});
`;

const M1_FIXED_MATH = `export function add(left, right) {
  return left + right;
}
`;

const M2_MATH = `export function add(left, right) {
  return left + right;
}

export function multiply(left, right) {
  return left * right;
}
`;

const M2_MATH_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { add, multiply } from './math.mjs';

test('add returns the sum of two positive integers', () => {
  assert.equal(add(2, 3), 5);
});

test('multiply returns the product of two positive integers', () => {
  assert.equal(multiply(3, 4), 12);
});
`;

const M3_FORMAT = `export function formatExpression(op, left, right, result) {
  return \`\${left} \${op} \${right} = \${result}\`;
}
`;

const M3_FORMAT_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { formatExpression } from './format.mjs';

test('formatExpression formats basic equations', () => {
  assert.equal(formatExpression('+', 2, 3, 5), '2 + 3 = 5');
  assert.equal(formatExpression('*', 3, 4, 12), '3 * 4 = 12');
});
`;

const IMPLEMENTER_TASKS = {
  "m1-implement": {
    files: [{ path: "src/math.mjs", content: M1_FIXED_MATH }],
    testCommand: "node --test",
    commitMessage: "fix(math): correct addition",
    report: "DONE m1-implement: add() returns the sum, node --test passed, committed on branch.",
  },
  "m2-implement": {
    files: [
      { path: "src/math.mjs", content: M2_MATH },
      { path: "src/math.test.mjs", content: M2_MATH_TEST },
    ],
    testCommand: "node --test",
    commitMessage: "feat(math): add multiplication",
    report:
      "DONE m2-implement: multiply() added with tests, node --test passed, committed on branch.",
  },
  "m3-implement": {
    files: [
      { path: "src/format.mjs", content: M3_FORMAT },
      { path: "src/format.test.mjs", content: M3_FORMAT_TEST },
    ],
    testCommand: "node --test src/format.test.mjs",
    commitMessage: "feat(format): add expression formatter",
    report:
      "DONE m3-implement: formatExpression() added, scoped tests passed, committed on branch.",
  },
} as const;

type ImplementerTaskId = keyof typeof IMPLEMENTER_TASKS;

const INSPECTOR_TEST_COMMANDS: Record<string, string> = {
  "m1-inspect": "node --test",
  "m2-inspect": "node --test",
  "m3-inspect": "node --test src/format.test.mjs",
};

function implementerPrompt(taskId: ImplementerTaskId): string {
  const task = IMPLEMENTER_TASKS[taskId];
  const milestoneId = milestoneIdForTask(taskId);
  const instruction =
    MILESTONE_PLAN.find(({ id }) => id === milestoneId)?.instruction ??
    "Complete the milestone instruction.";
  return [
    `STUDIO-DEMO-TASK ${taskId}`,
    "You are an isolated Studio implementation worker inside your own managed worktree.",
    `Milestone: ${milestoneId}.`,
    `Goal: ${instruction}`,
    `Definition of done: "${task.testCommand}" passes in this worktree and every change is committed on this worktree branch with message "${task.commitMessage}".`,
    "Do not push, do not open pull requests, and do not touch files outside this milestone.",
    "Report a single DONE line when finished.",
  ].join("\n");
}

function milestoneIdForTask(taskId: ImplementerTaskId): string {
  return taskId === "m1-implement"
    ? "m1-addition"
    : taskId === "m2-implement"
      ? "m2-multiplication"
      : "m3-formatting";
}

function inspectorPrompt(taskId: string, worktreePath: string, branchName: string): string {
  const milestoneId = taskId.replace("-inspect", "");
  const testCommand = INSPECTOR_TEST_COMMANDS[taskId] ?? "node --test";
  return [
    `STUDIO-DEMO-TASK ${taskId}`,
    "You are an independent Studio inspector. Trust only the repository, never a worker report.",
    `WORKTREE: ${worktreePath.replaceAll("\\", "/")}`,
    `BRANCH: ${branchName}`,
    `Milestone under inspection: ${milestoneId}. Test command: "${testCommand}".`,
    "Inspect the branch diff against main inside that worktree, check git status there, then run the test command inside that worktree.",
    "Finish with exactly one verdict line starting with PASS or FAIL, followed by the evidence you observed.",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Coordinator state machine                                                  */
/* -------------------------------------------------------------------------- */

interface RunMilestoneView {
  readonly status: string;
  readonly title: string;
  readonly instruction: string;
  readonly dependsOn: readonly string[];
  readonly workerThreadIds: readonly string[];
  readonly worktreeIds: readonly string[];
}

interface RunView {
  readonly id: string;
  readonly workspaceId: string;
  readonly repositoryPath: string;
  readonly specification: string;
  readonly mode: string;
  readonly status: string;
  readonly createdAt: string;
  readonly revision: number;
  readonly milestoneOrder: readonly string[];
  readonly milestones: Readonly<Record<string, RunMilestoneView>>;
}

interface ChildView {
  readonly childThreadId?: string;
  readonly branch?: string;
  readonly worktreePath?: string;
  readonly createFailed?: boolean;
  status?: string;
}

interface CoordinatorState {
  project?: { workspaceId: string; repositoryPath: string };
  run?: RunView;
  children: Map<string, ChildView>;
  reads: Set<string>;
  mergedBranches: Set<string>;
  dependencyGateError: boolean;
  capProbeError: boolean;
  listThreadsAfterMerge: Set<string>;
  lastExchange?: { name: string; failed: boolean; resultText: string };
  exchangeCount: number;
}

const SAVE_SUCCESS = /^Saved Studio run /;
const CREATE_SUCCESS = /^Created child thread:/;
const LIST_THREADS_SUCCESS = /^(Visible threads:|No visible threads\.)/;
const READ_SUCCESS = /^Thread /;

function parseRun(raw: Record<string, unknown>): RunView | undefined {
  if (typeof raw.id !== "string" || !Array.isArray(raw.milestones)) return undefined;
  const milestones: Record<string, RunMilestoneView> = {};
  const milestoneOrder: string[] = [];
  for (const entry of raw.milestones as Record<string, unknown>[]) {
    if (typeof entry.id !== "string") continue;
    milestoneOrder.push(entry.id);
    milestones[entry.id] = {
      status: String(entry.status ?? "queued"),
      title: String(entry.title ?? entry.id),
      instruction: String(entry.instruction ?? ""),
      dependsOn: Array.isArray(entry.dependsOn) ? (entry.dependsOn as string[]) : [],
      workerThreadIds: Array.isArray(entry.workerThreadIds)
        ? (entry.workerThreadIds as string[])
        : [],
      worktreeIds: Array.isArray(entry.worktreeIds) ? (entry.worktreeIds as string[]) : [],
    };
  }
  return {
    id: raw.id,
    workspaceId: String(raw.workspaceId ?? ""),
    repositoryPath: String(raw.repositoryPath ?? ""),
    specification: String(raw.specification ?? ""),
    mode: String(raw.mode ?? "observed"),
    status: String(raw.status ?? "draft"),
    createdAt: String(raw.createdAt ?? new Date().toISOString()),
    revision: Number(raw.revision ?? 1),
    milestoneOrder,
    milestones,
  };
}

function reconstructCoordinator(context: ScriptedRequestContext): CoordinatorState {
  const state: CoordinatorState = {
    children: new Map(),
    reads: new Set(),
    mergedBranches: new Set(),
    dependencyGateError: false,
    capProbeError: false,
    listThreadsAfterMerge: new Set(),
    exchangeCount: 0,
  };
  const exchanges = toolExchanges(context);
  let lastMergeIndexByBranch = new Map<string, number>();
  exchanges.forEach((exchange, index) => {
    state.exchangeCount = index + 1;
    const text = exchange.resultText;
    const failed =
      text !== "" &&
      !(
        SAVE_SUCCESS.test(text) ||
        CREATE_SUCCESS.test(text) ||
        LIST_THREADS_SUCCESS.test(text) ||
        READ_SUCCESS.test(text) ||
        text.startsWith("Child status changed") ||
        text.startsWith("Wait timed out") ||
        text.startsWith("Wait cancelled") ||
        exchange.name === "bash" ||
        exchange.name === "powershell" ||
        exchange.name === "write"
      );
    state.lastExchange = { name: exchange.name, failed, resultText: text };
    if (exchange.name === "list_studio_runs" && text.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(text) as {
          project?: { workspaceId?: string; repositoryPath?: string };
          runs?: Record<string, unknown>[];
        };
        if (parsed.project?.workspaceId && parsed.project.repositoryPath) {
          state.project = {
            workspaceId: parsed.project.workspaceId,
            repositoryPath: parsed.project.repositoryPath,
          };
        }
        const run = parsed.runs?.[0];
        if (run) {
          const parsedRun = parseRun(run);
          if (parsedRun) state.run = parsedRun;
        }
      } catch {
        // Ignore malformed list results; the next phase re-lists.
      }
    }
    if (exchange.name === "save_studio_run") {
      if (SAVE_SUCCESS.test(text)) {
        const parsedRun = parseRun(exchange.args.run as Record<string, unknown>);
        if (parsedRun) state.run = parsedRun;
      } else if (/Milestone dependencies are not complete/i.test(text)) {
        state.dependencyGateError = true;
      }
    }
    if (exchange.name === "create_child_thread") {
      const taskId = String(exchange.args.task_id ?? "");
      if (CREATE_SUCCESS.test(text)) {
        const childThreadId = /childThreadId:\s*(\S+)/.exec(text)?.[1];
        const branch = /branch:\s*(\S+)/.exec(text)?.[1];
        const worktreePath = /worktreePath:\s*(\S+)/.exec(text)?.[1];
        if (taskId && childThreadId) {
          state.children.set(taskId, {
            childThreadId,
            ...(branch ? { branch } : {}),
            ...(worktreePath ? { worktreePath } : {}),
          });
        }
      } else if (text !== "" && taskId) {
        const previous = state.children.get(taskId);
        state.children.set(taskId, { ...previous, createFailed: true });
        if (/At most 2 child threads/i.test(text)) {
          state.capProbeError = true;
        }
      }
    }
    if (exchange.name === "wait_for_child_threads") {
      for (const line of text.split("\n")) {
        const match = /^- .*STUDIO-DEMO-TASK ([a-z0-9-]+).*: (\w+)/.exec(line.trim());
        if (match?.[1] && match[2]) {
          const child = state.children.get(match[1]);
          state.children.set(match[1], { ...child, status: match[2] });
        }
      }
    }
    if (exchange.name === "read_thread" && READ_SUCCESS.test(text)) {
      state.reads.add(String(exchange.args.thread_id ?? ""));
    }
    if (exchange.name === "bash" || exchange.name === "powershell") {
      const command = String(exchange.args.command ?? "");
      const mergeMatch = /^git merge --no-ff (\S+)/.exec(command.trim());
      if (mergeMatch?.[1]) {
        state.mergedBranches.add(mergeMatch[1]);
        lastMergeIndexByBranch = new Map(lastMergeIndexByBranch).set(mergeMatch[1], index);
      }
    }
    if (exchange.name === "list_threads" && LIST_THREADS_SUCCESS.test(text)) {
      for (const [branch, mergeIndex] of lastMergeIndexByBranch) {
        if (index > mergeIndex) state.listThreadsAfterMerge.add(branch);
      }
    }
  });
  return state;
}

interface RunMutation {
  status?: string;
  milestone?: {
    id: string;
    status?: string;
    appendWorkerId?: string;
    appendWorktreeId?: string;
  };
  appendMilestones?: readonly (typeof MILESTONE_PLAN)[number][];
}

function buildSavePayload(state: CoordinatorState, mutation: RunMutation): ScriptedResponse {
  const run = state.run;
  if (!run || !state.project) {
    return scriptedToolCall("list_studio_runs", {});
  }
  const now = new Date().toISOString();
  const milestoneOrder = [...run.milestoneOrder];
  const milestones: Record<string, RunMilestoneView> = { ...run.milestones };
  if (mutation.appendMilestones) {
    for (const planned of mutation.appendMilestones) {
      if (milestones[planned.id]) continue;
      milestoneOrder.push(planned.id);
      milestones[planned.id] = {
        status: "queued",
        title: planned.title,
        instruction: planned.instruction,
        dependsOn: planned.dependsOn,
        workerThreadIds: [],
        worktreeIds: [],
      };
    }
  }
  if (mutation.milestone) {
    const target = milestones[mutation.milestone.id];
    if (target) {
      milestones[mutation.milestone.id] = {
        ...target,
        ...(mutation.milestone.status ? { status: mutation.milestone.status } : {}),
        ...(mutation.milestone.appendWorkerId &&
        !target.workerThreadIds.includes(mutation.milestone.appendWorkerId)
          ? { workerThreadIds: [...target.workerThreadIds, mutation.milestone.appendWorkerId] }
          : {}),
        ...(mutation.milestone.appendWorktreeId &&
        !target.worktreeIds.includes(mutation.milestone.appendWorktreeId)
          ? { worktreeIds: [...target.worktreeIds, mutation.milestone.appendWorktreeId] }
          : {}),
      };
    }
  }
  return scriptedToolCall("save_studio_run", {
    run: {
      id: run.id,
      workspaceId: state.project.workspaceId,
      repositoryPath: state.project.repositoryPath,
      specification: run.specification,
      mode: run.mode,
      status: mutation.status ?? run.status,
      milestones: milestoneOrder.map((id) => {
        const milestone = milestones[id]!;
        return {
          id,
          title: milestone.title,
          instruction: milestone.instruction,
          dependsOn: milestone.dependsOn,
          status: milestone.status,
          workerThreadIds: milestone.workerThreadIds,
          worktreeIds: milestone.worktreeIds,
          updatedAt: now,
        };
      }),
      createdAt: run.createdAt,
      updatedAt: now,
      revision: run.revision + 1,
    },
  });
}

function childStatus(state: CoordinatorState, taskId: string): string | undefined {
  return state.children.get(taskId)?.status;
}

function childId(state: CoordinatorState, taskId: string): string | undefined {
  return state.children.get(taskId)?.childThreadId;
}

function createImplementer(taskId: ImplementerTaskId): ScriptedResponse {
  return scriptedToolCall("create_child_thread", {
    prompt: implementerPrompt(taskId),
    task_id: taskId,
    role: "IMPLEMENTER",
    environment: "worktree",
  });
}

function createInspector(state: CoordinatorState, taskId: string): ScriptedResponse {
  const implementerTask = `${taskId.replace("-inspect", "")}-implement`;
  const implementer = state.children.get(implementerTask);
  const worktreePath = implementer?.worktreePath ?? "<unknown-worktree>";
  const branch = implementer?.branch ?? "<unknown-branch>";
  return scriptedToolCall("create_child_thread", {
    prompt: inspectorPrompt(taskId, worktreePath, branch),
    task_id: taskId,
    role: "INDEPENDENT_INSPECTOR",
    environment: "local",
  });
}

function waitFor(taskIds: readonly string[], state: CoordinatorState): ScriptedResponse {
  const threadIds = taskIds
    .map((taskId) => childId(state, taskId))
    .filter((id): id is string => Boolean(id));
  return scriptedToolCall("wait_for_child_threads", {
    thread_ids: threadIds,
    // Waiting is host-side and costs no inference; one long wait replaces a
    // polling loop of short ones.
    timeout_ms: 300_000,
  });
}

function mergeBranch(shell: string, branch: string, milestoneId: string): ScriptedResponse {
  return scriptedToolCall(shell, {
    command: `git merge --no-ff ${branch} -m "studio(${milestoneId}): integrate locally verified work"`,
  });
}

/**
 * The scripted coordinator policy. Each response is chosen purely from the
 * reconstructed conversation state, so replayed or reordered requests converge
 * instead of double-dispatching.
 */
function coordinatorRespond(context: ScriptedRequestContext): ScriptedResponse {
  const state = reconstructCoordinator(context);
  const shell = () => pickShellTool(context.toolNames);
  if (!state.project || !state.run) {
    return scriptedToolCall("list_studio_runs", {});
  }
  const run = state.run;
  const last = state.lastExchange;
  if (
    last?.name === "save_studio_run" &&
    last.failed &&
    /changed elsewhere|reload/i.test(last.resultText)
  ) {
    return scriptedToolCall("list_studio_runs", {});
  }
  if (run.status === "draft") {
    return buildSavePayload(state, { status: "running" });
  }
  const placeholderId = `${run.id}-plan`;
  const placeholder = run.milestones[placeholderId];
  const m1 = run.milestones["m1-addition"];
  const m2 = run.milestones["m2-multiplication"];
  const m3 = run.milestones["m3-formatting"];
  if (placeholder && placeholder.status === "queued" && !m1) {
    return buildSavePayload(state, {
      milestone: { id: placeholderId, status: "cancelled" },
      appendMilestones: MILESTONE_PLAN,
    });
  }
  if (!m1 || !m2 || !m3) {
    return scriptedToolCall("list_studio_runs", {});
  }
  // Requirement: M2 stays blocked until M1 satisfies its delivery requirement.
  // The coordinator provably attempts the early transition and the host rejects it.
  if (m2.status === "queued" && m1.status !== "complete" && !state.dependencyGateError) {
    return buildSavePayload(state, { milestone: { id: "m2-multiplication", status: "running" } });
  }
  if (m1.status === "queued") {
    return buildSavePayload(state, { milestone: { id: "m1-addition", status: "running" } });
  }
  if (m3.status === "queued") {
    return buildSavePayload(state, { milestone: { id: "m3-formatting", status: "running" } });
  }
  const m1Impl = state.children.get("m1-implement");
  const m3Impl = state.children.get("m3-implement");
  if (!m1Impl) return createImplementer("m1-implement");
  if (!m3Impl) return createImplementer("m3-implement");
  const implsDone =
    childStatus(state, "m1-implement") === "complete" &&
    childStatus(state, "m3-implement") === "complete";
  // Requirement: the two-worker cap is enforced by the runtime, with inspection
  // capacity recovered by waiting for workers to finish first.
  if (!state.capProbeError && !state.children.has("m1-inspect") && !implsDone) {
    return createInspector(state, "m1-inspect");
  }

  const verifyFlow = (
    milestoneId: string,
    implementerTask: string,
    inspectorTask: string,
  ): ScriptedResponse | undefined => {
    const milestone = run.milestones[milestoneId]!;
    const implementer = state.children.get(implementerTask);
    const inspector = state.children.get(inspectorTask);
    const branch = implementer?.branch ?? "";
    const worktreePath = implementer?.worktreePath ?? "";
    if (milestone.status === "running") {
      if (childStatus(state, implementerTask) !== "complete") {
        return waitFor([implementerTask], state);
      }
      return buildSavePayload(state, {
        milestone: {
          id: milestoneId,
          status: "verifying",
          ...(implementer?.childThreadId ? { appendWorkerId: implementer.childThreadId } : {}),
          ...(worktreePath ? { appendWorktreeId: worktreePath } : {}),
        },
      });
    }
    if (milestone.status === "verifying") {
      if (!inspector?.childThreadId) {
        return createInspector(state, inspectorTask);
      }
      if (childStatus(state, inspectorTask) !== "complete") {
        return waitFor([inspectorTask], state);
      }
      if (!state.reads.has(inspector.childThreadId)) {
        return scriptedToolCall("read_thread", { thread_id: inspector.childThreadId });
      }
      if (branch && !state.mergedBranches.has(branch)) {
        return mergeBranch(shell(), branch, milestoneId);
      }
      if (branch && !state.listThreadsAfterMerge.has(branch)) {
        return scriptedToolCall("list_threads", {});
      }
      return buildSavePayload(state, {
        milestone: {
          id: milestoneId,
          status: "complete",
          ...(inspector.childThreadId ? { appendWorkerId: inspector.childThreadId } : {}),
        },
      });
    }
    return undefined;
  };

  if (m1.status === "running" || m1.status === "verifying") {
    // M1 verifies first; M3 waits for a free inspection slot, proving the cap.
    if (m1.status === "running") {
      if (childStatus(state, "m1-implement") !== "complete") {
        return waitFor(["m1-implement", "m3-implement"], state);
      }
      return buildSavePayload(state, {
        milestone: {
          id: "m1-addition",
          status: "verifying",
          ...(childId(state, "m1-implement")
            ? { appendWorkerId: childId(state, "m1-implement")! }
            : {}),
          ...(m1Impl?.worktreePath ? { appendWorktreeId: m1Impl.worktreePath } : {}),
        },
      });
    }
    const inspecting = verifyFlow("m1-addition", "m1-implement", "m1-inspect");
    if (inspecting) return inspecting;
  }
  if (m1.status === "complete" && m2.status === "queued") {
    // M1 satisfied its actual local delivery requirement; M2 unblocks now.
    return buildSavePayload(state, { milestone: { id: "m2-multiplication", status: "running" } });
  }
  if (m2.status === "running" && !state.children.has("m2-implement")) {
    return createImplementer("m2-implement");
  }
  if (m3.status === "running" || m3.status === "verifying") {
    if (m3.status === "running") {
      if (childStatus(state, "m3-implement") !== "complete") {
        // The status of a child is only observed through wait results; keep
        // waiting (optionally alongside the M2 worker) until M3 reports in.
        const waiting = ["m3-implement"];
        if (
          state.children.has("m2-implement") &&
          childStatus(state, "m2-implement") !== "complete"
        ) {
          waiting.push("m2-implement");
        }
        return waitFor(waiting, state);
      }
      return buildSavePayload(state, {
        milestone: {
          id: "m3-formatting",
          status: "verifying",
          ...(childId(state, "m3-implement")
            ? { appendWorkerId: childId(state, "m3-implement")! }
            : {}),
          ...(m3Impl?.worktreePath ? { appendWorktreeId: m3Impl.worktreePath } : {}),
        },
      });
    }
    // M3 verifies while the M2 implementation worker is still running:
    // two active children, one implementing and one inspecting.
    if (m3.status === "verifying") {
      const inspector = state.children.get("m3-inspect");
      if (!inspector?.childThreadId) {
        return createInspector(state, "m3-inspect");
      }
      if (childStatus(state, "m3-inspect") !== "complete") {
        const waiting = ["m3-inspect"];
        if (
          state.children.has("m2-implement") &&
          childStatus(state, "m2-implement") !== "complete"
        ) {
          waiting.push("m2-implement");
        }
        return waitFor(waiting, state);
      }
      const flow = verifyFlow("m3-formatting", "m3-implement", "m3-inspect");
      if (flow) return flow;
    }
  }
  if (m2.status === "running" || m2.status === "verifying") {
    const flow = verifyFlow("m2-multiplication", "m2-implement", "m2-inspect");
    if (flow) return flow;
  }
  const finished = m1.status === "complete" && m2.status === "complete" && m3.status === "complete";
  if (finished && run.status === "running") {
    return buildSavePayload(state, { status: "completed" });
  }
  if (run.status === "completed") {
    return scriptedText(
      `STUDIO-DEMO-COMPLETE run=${run.id} revision=${run.revision} ` +
        `children=${[...state.children.values()].filter((c) => c.childThreadId).length}`,
    );
  }
  return scriptedText(
    `STUDIO-DEMO-STALLED run=${run.status} m1=${m1.status} m2=${m2.status} m3=${m3.status} ` +
      `children=${[...state.children.entries()].map(([k, v]) => `${k}:${v.status ?? "?"}`).join(",")}`,
  );
}

const coordinatorActor: ScriptedActor = {
  name: "coordinator",
  matches: (context) => userText(context).includes("/studio start"),
  respond: coordinatorRespond,
};

function createImplementerActor(taskId: ImplementerTaskId): ScriptedActor {
  const task = IMPLEMENTER_TASKS[taskId];
  return {
    name: `implementer:${taskId}`,
    matches: (context) => userText(context).includes(`STUDIO-DEMO-TASK ${taskId}`),
    respond: (context): ScriptedResponse => {
      const shell = pickShellTool(context.toolNames);
      const step = assistantTurnCount(context);
      const file = task.files[step];
      if (file) {
        return scriptedToolCall("write", { path: file.path, content: file.content });
      }
      const commandStep = step - task.files.length;
      // The settle step keeps both implementation workers genuinely active at
      // the same time, so the coordinator's third dispatch deterministically
      // proves the runtime-enforced two-child cap.
      const commands = [
        'node -e "setTimeout(function(){}, 3000)"',
        task.testCommand,
        "git add -A",
        `git commit -m "${task.commitMessage}"`,
      ];
      const command = commands[commandStep];
      if (command) {
        return scriptedToolCall(shell, { command });
      }
      return scriptedText(task.report);
    },
  };
}

function createInspectorActor(taskId: string): ScriptedActor {
  const testCommand = INSPECTOR_TEST_COMMANDS[taskId] ?? "node --test";
  return {
    name: `inspector:${taskId}`,
    matches: (context) => userText(context).includes(`STUDIO-DEMO-TASK ${taskId}`),
    respond: (context): ScriptedResponse => {
      const shell = pickShellTool(context.toolNames);
      const prompt = userText(context);
      const worktree = /^WORKTREE: (.+)$/m.exec(prompt)?.[1]?.trim() ?? "";
      const branch = /^BRANCH: (.+)$/m.exec(prompt)?.[1]?.trim() ?? "";
      const step = assistantTurnCount(context);
      if (!worktree) {
        return scriptedText(`FAIL: inspector prompt for ${taskId} carried no WORKTREE line.`);
      }
      if (step === 0) {
        return scriptedToolCall(shell, { command: `cd "${worktree}"; git diff main...HEAD` });
      }
      if (step === 1) {
        return scriptedToolCall(shell, { command: `cd "${worktree}"; git status --short` });
      }
      if (step === 2) {
        return scriptedToolCall(shell, { command: `cd "${worktree}"; ${testCommand}` });
      }
      const exchanges = toolExchanges(context);
      const testResult = [...exchanges]
        .reverse()
        .find((entry) => String(entry.args.command ?? "").includes("node --test"));
      const output = testResult?.resultText ?? "";
      // Node's test runner prints TAP ("# fail 0") or the spec reporter
      // ("ℹ fail 0") depending on version/TTY; accept either, reject any
      // failing or non-observed run.
      const passed =
        output !== "" &&
        /\bfail\s+0\b/.test(output) &&
        !/\bnot ok\b/.test(output) &&
        !/\bfail\s+[1-9]/.test(output);
      if (!passed) {
        return scriptedText(
          `FAIL: ${taskId} inspection of ${branch} did not observe a clean passing test run.`,
        );
      }
      return scriptedText(
        `PASS: ${taskId} independently inspected branch ${branch} at ${worktree}: ` +
          `git diff main...HEAD and git status were reviewed and "${testCommand}" reported zero failures.`,
      );
    },
  };
}

const titleActor: ScriptedActor = {
  name: "thread-title",
  matches: (context) => allText(context).includes("You generate concise UI thread titles"),
  respond: () => scriptedText("Studio demo thread"),
};

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd });
  return result.stdout.trim();
}

test("Studio coordinates a real three-milestone run through native Pi child threads", async () => {
  test.setTimeout(480_000);
  const demoStartedAt = Date.now();
  const proofDir = process.env.PI_APP_STUDIO_DEMO_PROOF_DIR?.trim();
  if (proofDir) {
    await mkdir(proofDir, { recursive: true });
  }

  const server = await startScriptedOpenAiServer([
    titleActor,
    createImplementerActor("m1-implement"),
    createImplementerActor("m2-implement"),
    createImplementerActor("m3-implement"),
    createInspectorActor("m1-inspect"),
    createInspectorActor("m2-inspect"),
    createInspectorActor("m3-inspect"),
    coordinatorActor,
  ]);

  const workspacePath = await makeGitWorkspace("studio-three-milestone-runtime");
  await writeTextFile(
    join(workspacePath, "package.json"),
    `${JSON.stringify(
      { name: "studio-demo-math", private: true, type: "module", version: "1.0.0" },
      null,
      2,
    )}\n`,
  );
  await mkdir(join(workspacePath, "src"), { recursive: true });
  await writeTextFile(join(workspacePath, "src", "math.mjs"), BASELINE_MATH);
  await writeTextFile(join(workspacePath, "src", "math.test.mjs"), BASELINE_MATH_TEST);
  await commitAllInGitRepo(workspacePath, "baseline: intentionally failing addition");
  const baselineSha = await gitOutput(workspacePath, ["rev-parse", "HEAD"]);
  await expect(
    execFileAsync("node", ["--test"], { cwd: workspacePath }).then(
      () => "passed",
      () => "failed",
    ),
  ).resolves.toBe("failed");

  const userDataDir = await makeUserDataDir("pi-gui-studio-demo-");
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: [`studio-fixture/${server.modelId}`],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: "studio-fixture",
        defaultModel: server.modelId,
        enabledModels: [`studio-fixture/${server.modelId}`],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    join(agentDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          "studio-fixture": {
            baseUrl: server.baseUrl,
            api: "openai-completions",
            apiKey: "unused",
            models: [{ id: server.modelId }],
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    // 1. A real coordinator session in the project workspace.
    await createNamedThread(window, "Studio coordinator");
    const coordinatorSessionId = (await getDesktopState(window)).selectedSessionId;
    expect(coordinatorSessionId).toBeTruthy();

    // 2. Record the plan through the authorised UI path with the explicit
    //    local-only demonstration delivery policy (host-owned; the model-facing
    //    save path still forces github-pr for new milestones).
    await window.getByTestId("sidebar-studio").click();
    await expect(window.getByTestId("studio-runs-view")).toBeVisible();
    await window.getByLabel("Delivery").selectOption("local");
    await window.getByLabel("Specification or implementation packet").fill(SPECIFICATION);
    await window.getByRole("button", { name: "Prepare in current thread" }).click();
    await expect(window.getByTestId("sidebar-studio")).toBeVisible();
    await window.getByTestId("sidebar-studio").click();
    await expect
      .poll(async () => {
        const state = await getDesktopState(window);
        return state.studioRuns[0]?.status;
      })
      .toBe("draft");
    expect((await getDesktopState(window)).studioRuns[0]).toMatchObject({
      deliveryPolicy: "local",
      coordinatorSessionId,
      milestones: [expect.objectContaining({ deliveryRequirement: "local" })],
    });

    // 3. Start: sends /studio start to the real coordinator session; from here
    //    every step is the model calling native Pi orchestration tools.
    await window.getByRole("button", { name: "Start in prepared thread" }).click();

    // 4. The run must reach completed through the host verification gate.
    try {
      await expect
        .poll(
          async () => {
            const state = await getDesktopState(window);
            const run = state.studioRuns[0];
            if (!run) return "missing";
            if (run.status === "completed") return "completed";
            const stalled = run.milestones
              .map((milestone) => `${milestone.id}:${milestone.status}`)
              .join(",");
            return `${run.status}[${stalled}]`;
          },
          { timeout: 240_000 },
        )
        .toBe("completed");
    } catch (error) {
      const stalledState = await getDesktopState(window);
      const diagnostics = {
        studioRun: stalledState.studioRuns[0],
        children: stalledState.orchestrationChildren.map((child) => ({
          taskId: child.taskId,
          role: child.role,
          status: child.status,
          branchName: child.branchName,
          worktreePath: child.worktreePath,
          latestTranscript: child.latestTranscript?.slice(0, 600),
          transcript: child.transcript.slice(-8),
          evidence: child.evidence.slice(0, 14).map((record) => ({
            title: record.title,
            status: record.status,
            command: record.command,
            detail: record.detail?.slice(0, 400),
          })),
        })),
        coordinatorResponses: server
          .requestLog()
          .filter((entry) => entry.actor === "coordinator")
          .slice(-14)
          .map((entry) => entry.response),
        recentRequests: server
          .requestLog()
          .slice(-24)
          .map((entry) => ({
            actor: entry.actor,
            response: entry.response,
            lastToolResults: toolExchanges({
              messages: entry.messages,
              toolNames: [],
              model: entry.response.kind === "tool" ? entry.response.toolCall.name : "",
            })
              .slice(-3)
              .map((exchange) => ({
                name: exchange.name,
                result: exchange.resultText.slice(0, 500),
              })),
          })),
      };
      const diagnosticsPath = join(userDataDir, "stall-diagnostics.json");
      await writeFile(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`);
      console.log(`Studio demo stalled; diagnostics written to ${diagnosticsPath}`);
      console.log(JSON.stringify(diagnostics, null, 2).slice(0, 30_000));
      throw error;
    }

    const finalState = await getDesktopState(window);
    const run = finalState.studioRuns[0]!;

    /* ---------------- Acceptance evidence ---------------- */

    // (1) Real coordinator session persisted the plan and kept its binding.
    expect(run.coordinatorSessionId).toBe(coordinatorSessionId);
    expect(run.workspaceId).toBeTruthy();
    expect(run.repositoryPath.toLowerCase()).toBe(workspacePath.toLowerCase());
    expect(run.specification).toBe(SPECIFICATION);
    expect(run.deliveryPolicy).toBe("local");
    expect(run.status).toBe("completed");

    const byId = new Map(run.milestones.map((milestone) => [milestone.id, milestone]));
    const placeholder = byId.get(`${run.id}-plan`);
    expect(placeholder?.status).toBe("cancelled");
    for (const planned of MILESTONE_PLAN) {
      const milestone = byId.get(planned.id);
      expect(milestone?.status, `${planned.id} status`).toBe("complete");
      expect(milestone?.deliveryRequirement, `${planned.id} delivery`).toBe("local");
      expect(milestone?.dependsOn).toEqual([...planned.dependsOn]);
    }

    // (2)+(3)+(8) Real child ids, worktree ids, roles and evidence.
    const childrenById = new Map(
      finalState.orchestrationChildren.map((child) => [child.id, child]),
    );
    for (const [milestoneId, implementerTask, inspectorTask] of [
      ["m1-addition", "m1-implement", "m1-inspect"],
      ["m2-multiplication", "m2-implement", "m2-inspect"],
      ["m3-formatting", "m3-implement", "m3-inspect"],
    ] as const) {
      const milestone = byId.get(milestoneId)!;
      const implementer = finalState.orchestrationChildren.find(
        (child) => child.taskId === implementerTask,
      );
      const inspector = finalState.orchestrationChildren.find(
        (child) => child.taskId === inspectorTask,
      );
      expect(implementer, `${implementerTask} record`).toMatchObject({
        role: "IMPLEMENTER",
        environment: "worktree",
        status: "complete",
        parentSessionId: coordinatorSessionId,
        model: { provider: "studio-fixture", modelId: server.modelId },
      });
      expect(implementer?.worktreePath).toBeTruthy();
      expect(implementer?.branchName).toMatch(/^pi\//);
      expect(inspector, `${inspectorTask} record`).toMatchObject({
        role: "INDEPENDENT_INSPECTOR",
        status: "complete",
      });
      expect(inspector?.parentSessionId).toBe(coordinatorSessionId);
      expect(milestone.workerThreadIds).toContain(implementer?.id);
      expect(milestone.workerThreadIds).toContain(inspector?.id);
      expect(milestone.worktreeIds).toContain(implementer?.worktreePath);
      expect(childrenById.get(implementer!.id)?.childSessionId).toBeTruthy();

      // Inspector evidence came from real tool execution, not worker claims.
      const evidence = inspector?.evidence ?? [];
      expect(
        evidence.some(
          (record) =>
            record.title === "Test command run" &&
            record.status === "passed" &&
            record.command?.includes("node --test"),
        ),
        `${inspectorTask} test evidence`,
      ).toBe(true);
      expect(
        evidence.some(
          (record) =>
            record.kind === "command" &&
            record.status === "passed" &&
            /\bgit\s+(diff|status)\b/.test(record.command ?? ""),
        ),
        `${inspectorTask} diff evidence`,
      ).toBe(true);
      expect(
        evidence.some(
          (record) =>
            record.kind === "orchestrator_observation" &&
            record.title === "Orchestrator read child output",
        ),
        `${inspectorTask} coordinator-read evidence`,
      ).toBe(true);
      const finalInspectorMessage = [...(inspector?.transcript ?? [])]
        .reverse()
        .find((message) => message.role === "child");
      expect(finalInspectorMessage?.text.trim().startsWith("PASS")).toBe(true);
    }

    // (4)+(5)+(6) Runtime-enforced cap, dependency gate and independent M3,
    // observed in the coordinator's real tool-result history. Wait for the
    // coordinator's final completion report so the logged conversation includes
    // every exchange, including the completed-run save.
    const isCompletionReport = (entry: {
      readonly actor: string;
      readonly response: ScriptedResponse;
    }) =>
      entry.actor === "coordinator" &&
      entry.response.kind === "text" &&
      entry.response.text.includes("STUDIO-DEMO-COMPLETE");
    await expect
      .poll(() => server.requestLog().some(isCompletionReport), { timeout: 60_000 })
      .toBe(true);
    const coordinatorRequests = server.requestLog().filter(isCompletionReport);
    const finalConversation = coordinatorRequests[coordinatorRequests.length - 1]!;
    const exchanges = toolExchanges({
      messages: finalConversation.messages,
      toolNames: [],
      model: server.modelId,
    });
    const indexOf = (predicate: (exchange: (typeof exchanges)[number]) => boolean) =>
      exchanges.findIndex(predicate);
    console.log(
      `coordinator requests: ${
        server.requestLog().filter((entry) => entry.actor === "coordinator").length
      }; actors seen: ${JSON.stringify(
        server.requestLog().reduce<Record<string, number>>((counts, entry) => {
          counts[entry.actor] = (counts[entry.actor] ?? 0) + 1;
          return counts;
        }, {}),
      )}`,
    );
    console.log(
      `coordinator exchanges:\n${exchanges
        .map((exchange, index) => {
          const savedRun = (exchange.args as { run?: { status?: string } }).run;
          const result = exchange.resultText.replace(/\s+/g, " ").slice(0, 90);
          return `  ${index}: ${exchange.name}${savedRun?.status ? ` run=${savedRun.status}` : ""} -> ${result}`;
        })
        .join("\n")}`,
    );
    const dependencyRejection = indexOf(
      (exchange) =>
        exchange.name === "save_studio_run" &&
        /Milestone dependencies are not complete/i.test(exchange.resultText),
    );
    const capRejection = indexOf(
      (exchange) =>
        exchange.name === "create_child_thread" &&
        /At most 2 child threads/i.test(exchange.resultText),
    );
    const staleParentReadRejections = exchanges.filter(
      (exchange) =>
        exchange.name === "save_studio_run" &&
        /must read the independent-inspector thread/i.test(exchange.resultText),
    );
    expect(dependencyRejection, "M2 must be rejected while M1 is undelivered").toBeGreaterThan(-1);
    expect(capRejection, "the two-child cap must reject an early inspector").toBeGreaterThan(-1);
    expect(
      staleParentReadRejections,
      "a fresh coordinator transcript must expose the successful inspector read immediately",
    ).toHaveLength(0);

    // Economy: evidence readiness is reconciled inside the host, so completion
    // saves must never be retried by the model while a read is in flight. The
    // pre-economy baseline needed 155 saves (143 rejected) for the same run.
    const saveExchanges = exchanges.filter((exchange) => exchange.name === "save_studio_run");
    const evidenceLagRejections = saveExchanges.filter((exchange) =>
      /must read the independent-inspector/i.test(exchange.resultText),
    );
    expect(
      evidenceLagRejections,
      "host-side reconciliation must absorb evidence lag without model-driven save retries",
    ).toHaveLength(0);
    expect(
      saveExchanges.length,
      "run bookkeeping must not require repeated model saves",
    ).toBeLessThanOrEqual(25);

    const firstSaveWith = (milestoneId: string, milestoneStatus: string) =>
      indexOf((exchange) => {
        if (
          exchange.name !== "save_studio_run" ||
          !/^Saved Studio run /.test(exchange.resultText)
        ) {
          return false;
        }
        const savedRun = exchange.args.run as {
          milestones?: readonly { id?: string; status?: string }[];
        };
        return Boolean(
          savedRun.milestones?.some(
            (milestone) => milestone.id === milestoneId && milestone.status === milestoneStatus,
          ),
        );
      });
    const m1CompleteSave = firstSaveWith("m1-addition", "complete");
    const m3ImplementerCreate = indexOf(
      (exchange) =>
        exchange.name === "create_child_thread" && exchange.args.task_id === "m3-implement",
    );
    const m2RunningSave = firstSaveWith("m2-multiplication", "running");
    expect(m1CompleteSave, "M1 must reach complete through the gate").toBeGreaterThan(-1);
    expect(m2RunningSave, "M2 must reach running after M1 delivery").toBeGreaterThan(-1);
    expect(m3ImplementerCreate).toBeGreaterThan(-1);
    expect(m3ImplementerCreate).toBeLessThan(m1CompleteSave);
    expect(dependencyRejection).toBeLessThan(m1CompleteSave);
    expect(m1CompleteSave).toBeLessThan(m2RunningSave);
    expect(capRejection).toBeLessThan(m1CompleteSave);

    // The completed-run save happened after every milestone completion.
    let completedRunSave = -1;
    exchanges.forEach((exchange, index) => {
      if (
        exchange.name === "save_studio_run" &&
        /^Saved Studio run /.test(exchange.resultText) &&
        (exchange.args.run as { status?: string })?.status === "completed"
      ) {
        completedRunSave = index;
      }
    });
    expect(completedRunSave).toBeGreaterThan(m1CompleteSave);
    expect(
      exchanges.some((exchange) =>
        /STUDIO-DEMO-STALLED/.test(JSON.stringify(exchange.args) + exchange.resultText),
      ),
    ).toBe(false);

    // (7) The host persisted the ledger: read it back from disk.
    const ledgerFile = JSON.parse(
      await readFile(join(userDataDir, "studio-runs.json"), "utf8"),
    ) as {
      version: number;
      runs: Record<string, unknown>[];
    };
    expect(ledgerFile.version).toBe(1);
    const persistedRun = ledgerFile.runs.find(
      (entry) => (entry as { id?: string }).id === run.id,
    ) as Record<string, unknown> | undefined;
    expect(persistedRun).toMatchObject({
      status: "completed",
      coordinatorSessionId,
      deliveryPolicy: "local",
    });
    const persistedChildren = JSON.parse(
      await readFile(join(userDataDir, "ui-state.json"), "utf8"),
    ) as { orchestrationChildren?: readonly Record<string, unknown>[] };
    const persistedTasks = (persistedChildren.orchestrationChildren ?? []).map(
      (child) => child.taskId,
    );
    for (const taskId of [
      "m1-implement",
      "m3-implement",
      "m1-inspect",
      "m2-implement",
      "m3-inspect",
      "m2-inspect",
    ]) {
      expect(persistedTasks, `persisted child ${taskId}`).toContain(taskId);
    }

    // The disposable repository really received and integrated the work.
    const mathSource = await readFile(join(workspacePath, "src", "math.mjs"), "utf8");
    expect(mathSource).toContain("return left + right");
    expect(mathSource).toContain("export function multiply");
    const formatSource = await readFile(join(workspacePath, "src", "format.mjs"), "utf8");
    expect(formatSource).toContain("formatExpression");
    await execFileAsync("node", ["--test"], { cwd: workspacePath });
    const log = await gitOutput(workspacePath, ["log", "--oneline", "main"]);
    expect(log).toContain("studio(m1-addition): integrate locally verified work");
    expect(log).toContain("studio(m2-multiplication): integrate locally verified work");
    expect(log).toContain("studio(m3-formatting): integrate locally verified work");
    expect(log).toContain("fix(math): correct addition");
    expect(log).toContain("feat(math): add multiplication");
    expect(log).toContain("feat(format): add expression formatter");
    const worktreeList = await gitOutput(workspacePath, ["worktree", "list"]);
    const implementerChildren = finalState.orchestrationChildren.filter(
      (child) => child.role === "IMPLEMENTER",
    );
    expect(implementerChildren).toHaveLength(3);
    for (const child of implementerChildren) {
      expect(worktreeList.replaceAll("\\", "/")).toContain(
        child.worktreePath!.replaceAll("\\", "/"),
      );
      const workerSha = await gitOutput(child.worktreePath!, ["rev-parse", "HEAD"]);
      expect(workerSha).not.toBe(baselineSha);
      const workerLog = await gitOutput(workspacePath, ["log", "--oneline", child.branchName!]);
      expect(workerLog.split("\n")[0]).toContain(workerSha.slice(0, 7));
    }

    // Pilot 1 economy accounting: turns, tool calls, saves, elapsed time,
    // coordinator context growth and combined token usage across the
    // coordinator and every child session (cached tokens included where the
    // provider reports them).
    const turnsByActor = server.requestLog().reduce<Record<string, number>>((counts, entry) => {
      counts[entry.actor] = (counts[entry.actor] ?? 0) + 1;
      return counts;
    }, {});
    const toolCallsByName = exchanges.reduce<Record<string, number>>((counts, exchange) => {
      counts[exchange.name] = (counts[exchange.name] ?? 0) + 1;
      return counts;
    }, {});
    const acceptedSaves = saveExchanges.filter((exchange) =>
      /^Saved Studio run /.test(exchange.resultText),
    ).length;
    const usageEntries = Object.entries(finalState.sessionUsageBySession);
    const combinedUsage = usageEntries.reduce(
      (acc, [, usage]) => ({
        input: acc.input + usage.totals.input,
        output: acc.output + usage.totals.output,
        cacheRead: acc.cacheRead + usage.totals.cacheRead,
        cacheWrite: acc.cacheWrite + usage.totals.cacheWrite,
        cost: acc.cost + usage.totals.cost,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    );
    const coordinatorChars = finalConversation.messages.reduce(
      (total, message) => total + messageText(message).length,
      0,
    );
    const costReport = {
      runId: run.id,
      finalRevision: run.revision,
      elapsedMs: Date.now() - demoStartedAt,
      modelTurns: {
        byActor: turnsByActor,
        total: Object.values(turnsByActor).reduce((sum, count) => sum + count, 0),
      },
      toolCalls: { byName: toolCallsByName, total: exchanges.length },
      saves: {
        total: saveExchanges.length,
        accepted: acceptedSaves,
        rejected: saveExchanges.length - acceptedSaves,
        evidenceLagRejections: evidenceLagRejections.length,
      },
      coordinatorContext: {
        messages: finalConversation.messages.length,
        chars: coordinatorChars,
        estimatedTokens: Math.round(coordinatorChars / 4),
      },
      tokenUsage:
        usageEntries.length > 0
          ? {
              sessions: usageEntries.length,
              combinedTotals: combinedUsage,
              bySession: finalState.sessionUsageBySession,
            }
          : {
              sessions: 0,
              note: "Fixture provider responses carry no usage; real-model runs report actual tokens.",
            },
      baseline: {
        note: "Pre-economy run studio-86466a8d-d3cd-4ca5-96f3-c978784b8ca3, same spec and machine",
        saves: 155,
        rejectedSaves: 143,
        evidenceLagRejections: 142,
        toolCalls: 178,
        elapsedMsApprox: 204_000,
      },
    };
    console.log(
      `Studio demo economy: turns=${costReport.modelTurns.total} ` +
        `toolCalls=${costReport.toolCalls.total} saves=${costReport.saves.total} ` +
        `(rejected ${costReport.saves.rejected}) ` +
        `coordinatorContext≈${costReport.coordinatorContext.estimatedTokens} est. tokens ` +
        `elapsedMs=${costReport.elapsedMs}`,
    );

    if (proofDir) {
      await window.getByTestId("sidebar-studio").click();
      await expect(window.getByTestId("studio-runs-view")).toBeVisible();
      await window.screenshot({
        path: join(proofDir, "studio-three-milestone-runtime-final.png"),
        fullPage: true,
      });
      await writeFile(
        join(proofDir, "studio-runs.json"),
        `${JSON.stringify(ledgerFile, null, 2)}\n`,
      );
      await writeFile(
        join(proofDir, "coordinator-tool-exchanges.json"),
        `${JSON.stringify(
          exchanges.map((exchange) => ({
            name: exchange.name,
            args: exchange.args,
            result: exchange.resultText.slice(0, 2000),
          })),
          null,
          2,
        )}\n`,
      );
      await writeFile(
        join(proofDir, "run-ids.json"),
        `${JSON.stringify(
          {
            userDataDir,
            workspacePath,
            baselineSha,
            coordinatorSessionId,
            runId: run.id,
            finalRevision: run.revision,
            children: finalState.orchestrationChildren.map((child) => ({
              taskId: child.taskId,
              childThreadId: child.id,
              childSessionId: child.childSessionId,
              role: child.role,
              environment: child.environment,
              branchName: child.branchName,
              worktreePath: child.worktreePath,
              status: child.status,
            })),
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(
        join(proofDir, "cost-report.json"),
        `${JSON.stringify(costReport, null, 2)}\n`,
      );
      console.log(`Studio three-milestone runtime demo artifacts: ${proofDir}`);
    }
    console.log(
      `Studio demo run ${run.id} completed at revision ${run.revision}; repository preserved at ${workspacePath}`,
    );
  } finally {
    await harness.close();
    await server.close();
  }
});
