import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const ROLES = [
  "COORDINATOR",
  "IMPLEMENTER",
  "FAST_WORKER",
  "RESEARCHER",
  "INDEPENDENT_INSPECTOR",
  "RELEASE_ENGINEER",
];
const DEFAULT_ROUTES = {
  COORDINATOR: "qwen-token-plan/qwen3.8-max",
  IMPLEMENTER: "qwen-token-plan/qwen3.8-max",
  FAST_WORKER: "qwen-token-plan/qwen3.8-flash",
  RESEARCHER: "qwen-token-plan/qwen3.8-flash",
  INDEPENDENT_INSPECTOR: "qwen-token-plan/deepseek-v4-flash-0731",
  RELEASE_ENGINEER: "qwen-token-plan/qwen3.8-max",
};
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
type StudioThinkingPreference = ModelThinkingLevel | "default";
const DEFAULT_THINKING_LEVEL: StudioThinkingPreference = "default";
interface RoleAssignment {
  model: string;
  thinkingLevel: StudioThinkingPreference;
}
type RoleAssignments = Record<string, RoleAssignment>;
const DEFAULT_ASSIGNMENTS: RoleAssignments = Object.fromEntries(
  Object.entries(DEFAULT_ROUTES).map(([role, model]) => [
    role,
    { model, thinkingLevel: DEFAULT_THINKING_LEVEL },
  ]),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is StudioThinkingPreference {
  return (
    value === "default" ||
    (typeof value === "string" &&
      THINKING_LEVELS.includes(value as (typeof THINKING_LEVELS)[number]))
  );
}

/** Read v1 route-only preferences and v2 route-plus-thinking preferences. */
export function parseRoleAssignments(value: unknown): RoleAssignments {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || !isRecord(value.roles)) {
    throw new Error("Matthew Way Studio model preferences have an unsupported format.");
  }

  const roles = { ...DEFAULT_ASSIGNMENTS };
  for (const [role, entry] of Object.entries(value.roles)) {
    if (typeof entry === "string") {
      roles[role] = { model: entry, thinkingLevel: DEFAULT_THINKING_LEVEL };
      continue;
    }
    if (value.version === 2 && isRecord(entry) && typeof entry.model === "string") {
      roles[role] = {
        model: entry.model,
        thinkingLevel: isThinkingLevel(entry.thinkingLevel)
          ? entry.thinkingLevel
          : DEFAULT_THINKING_LEVEL,
      };
    }
  }
  return roles;
}

/** Pi's catalog marks null levels unsupported; omit xhigh/max by policy. */
export function supportedThinkingLevels(model: {
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ModelThinkingLevel, string | null>>;
}): ModelThinkingLevel[] {
  const candidates: readonly ModelThinkingLevel[] = model.reasoning ? THINKING_LEVELS : ["off"];
  return candidates.filter((level) => model.thinkingLevelMap?.[level] !== null);
}

const STUDIO_PLAN = `You are Matthew's Pi GUI Studio coordinator. Use the current project's repository, tools, and instructions. This command begins in OBSERVED mode.
Use the current Pi GUI project ledger as the single durable Studio plan/progress record.
Adapt execution to packet size and coupling. For a single small, self-contained fix, keep one milestone and keep IMPLEMENTATION in the parent thread after explicit start; do not create an implementer child or worktree merely to satisfy a workflow. Verification is separate: unless the saved milestone is explicitly host-authorised with verificationRequirement "coordinator", repository-changing work still requires an INDEPENDENT_INSPECTOR child. Coordinator verification is only for a host-authorised small local milestone and still requires successful check evidence, a git diff/status inspection, and an exact final line "COORDINATOR-VERIFIED: <milestone-id> PASS". For one substantial implementation task, prefer one bounded child only when separate context or isolation adds value. For a broad specification, inspect first, derive ordered milestones and dependencies, and delegate at most two independent writers at once; use isolated app-managed worktrees for writers. Never parallelize dependent edits into the same repository checkout. Keep tests, review, PR checkpoints, and recovery proportional to the actual task while preserving every explicit acceptance criterion. A small task still gets evidence-backed completion and an honest report. Call list_studio_runs before planning or resuming and reconcile saved runs with the actual repository and threads. After presenting a new observed plan, save one complete StudioRun draft for the current project (revision 1, full specification, dependency-linked milestones, empty worker/worktree IDs, current timestamps) before waiting; do not dispatch from a draft. If a matching active run already exists, update that run only after reconciling its revision; never create a duplicate or overwrite a newer revision. For a LIVE CORRECTION tagged with an active run id and specification revision, reload that exact run and inspect the current repository, milestone graph, and worker threads. Increment specificationRevision only if the correction was not already recorded; append it to the same run. Identify affected and unaffected work plus dependency consequences; pause or redirect only affected work and preserve independent work. Save the reconciled graph at the next ledger revision, then continue the correction and unaffected work within existing limits. Never create a duplicate run or mark a correction applied before its implementation and evidence are checked. If the run identity or revision cannot be reconciled, stop without dispatch and report the conflict. On /studio start, reload and revalidate the same plan and repository baseline, then save status running at the next revision before creating children. After each worker or verification event, persist the same run with the next revision and the appropriate single milestone transition; if ledger save fails or state is stale, stop dispatch and report it. Do not invent repository/workspace identifiers: use the current project identity/path exposed by Pi GUI. If a required identity cannot be established, leave the plan unsaved and report the limitation.

  First inspect repository state, workflow triggers, and applicable instructions. Produce a bounded, dependency-aware plan with self-contained worker packets, roles, actual configured provider/model routes, and whether each writer needs an app-managed worktree. Apply the selected role's saved thinking preference when Pi reports it supported by the chosen model; when the preference is model-default, omit the thinking override. If the chosen route does not support a saved level, do not silently substitute another level. Never use xhigh or max thinking. Reuse existing capabilities. Cap concurrent workers at two. Never silently route subscription failures to metered APIs. Do not claim a provider entitlement or model route unless the session/tool evidence shows it.

Show the plan and wait. Do not create children, change files, run consequential actions, or start workers until Matthew explicitly invokes /studio start. Read-only inspection and planning are allowed. Do not treat a plan as approval.

After explicit start, dispatch independent writers in separate worktrees; do not let concurrent writers share a checkout. Use native child-thread tools and wait for completion events. Inspect actual diffs and revisions independently against the original acceptance criteria. Give at most two bounded repair attempts per failed task. Integrate in dependency order. Preserve failed/dirty worktrees.
Before issuing GitHub operations (such as branch pushes, opening PRs, or workflow dispatches) that initiate hosted jobs, inspect actual workflow triggers and existing runs. Apply Matthew Way CI Economy: CI is a shared, budgeted resource, not an automatic response to every code push. Prefer local deterministic checks during development, lightweight relevant CI at review checkpoints, and full platform/package verification when change or merge/release consequences justify it. Avoid redundant runs, cancel superseded PR jobs where safe, and distinguish billing/runner denial from actual test failure. Warn Matthew when reliably known account usage approaches 75%. Never guess quota, silently authorise paid usage, change spending limits, weaken required checks, or change repository visibility. Do not publish, release, deploy, or spend metered inference without separate authority. Report verified evidence and unresolved items; never infer success from worker claims.

Worker packets must state GOAL, BASELINE, SCOPE, NON-SCOPE, RELEVANT SEMANTICS, INVARIANTS, REUSE CHECK, IMPLEMENTATION GUIDANCE (including CI budget guidance: prefer local deterministic checks over triggering hosted CI), ACCEPTANCE EVIDENCE, STOP CONDITIONS, and DELIVERABLE. Keep packets compact but complete. Respect Matthew Way skills and repository-specific AGENTS.md; invoke relevant skills when appropriate, without loading all of them by default.

After completion, report actual changed files/revisions, commands and outcomes, independent inspection result, worktree identities, provider/model routes, local vs hosted evidence distinction with outstanding verification identified, and remaining gaps. The mode is observed for this run; never enable autonomous mode implicitly.`;

const STUDIO_START = `Matthew explicitly invoked /studio start. Continue the previously presented Studio plan only. Recheck that the plan and repository revision are still current, that the selected providers/models are the actual configured routes, and that there are no new blockers. Inspect workflow triggers and active runs before any push or GitHub operation. If any material plan assumption changed, stop and present the updated plan instead of dispatching. Otherwise run the approved plan within its stated scope and limits. This does not authorize release, publication, deployment, destructive cleanup, or metered inference.`;

function settingsPath() {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "studio-models.json");
}

async function readAssignments() {
  try {
    return parseRoleAssignments(JSON.parse(await readFile(settingsPath(), "utf8")));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { ...DEFAULT_ASSIGNMENTS };
    throw error;
  }
}

async function writeAssignments(roles: RoleAssignments) {
  const path = settingsPath();
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 2, roles }, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function catalogForContext(ctx: ExtensionCommandContext) {
  return ctx.scopedModels.length
    ? ctx.scopedModels.map(({ model }) => model)
    : ctx.modelRegistry.getAvailable();
}

function routeAvailability(
  ctx: ExtensionCommandContext,
  modelRef: string,
): "VERIFIED" | "UNAVAILABLE" {
  const [provider, ...modelIdParts] = modelRef.split("/");
  const modelId = modelIdParts.join("/");
  const model = catalogForContext(ctx).find(
    (entry) => entry.provider === provider && entry.id === modelId,
  );
  return model && ctx.modelRegistry.hasConfiguredAuth(model) ? "VERIFIED" : "UNAVAILABLE";
}

function formatPlan(
  assignments: RoleAssignments,
  ctx: ExtensionCommandContext,
  task = "",
) {
  const entries = ROLES.map((role) => {
    const assignment = assignments[role];
    return assignment?.model
      ? `- ${role}: ${assignment.model}; thinking ${formatThinking(
          assignment.thinkingLevel,
        )}; host route ${routeAvailability(ctx, assignment.model)}`
      : `- ${role}: use the coordinator's current route; no preference is saved`;
  });
  const taskContext = task.trim()
    ? `Matthew's requested task to plan:\n${task.trim()}`
    : "No specific task was supplied. Inspect only enough to identify what information is needed, then ask Matthew for the task specification; do not invent work.";
  return `${STUDIO_PLAN}\n\n${taskContext}\n\nMatthew Way Studio role-to-model preferences (host-checked against Pi's current catalog and configured auth):\n${entries.join("\n")}\nThese availability labels come from the Pi host, not model inference. Treat UNAVAILABLE as a hard stop for that role: block verification/dispatch and report it. Do not guess a replacement route and do not fall back to a different or metered provider silently.`;
}

function formatAssignments(
  assignments: RoleAssignments,
  ctx: ExtensionCommandContext,
) {
  return ROLES.map((role) => {
    const assignment = assignments[role];
    return assignment?.model
      ? `- ${role}: ${assignment.model}; thinking ${formatThinking(
          assignment.thinkingLevel,
        )}; host route ${routeAvailability(ctx, assignment.model)}`
      : `- ${role}: use the coordinator's current route; no preference is saved`;
  }).join("\n");
}

function formatThinking(level: StudioThinkingPreference): string {
  return level === "default" ? "model default" : level;
}

async function chooseRoleModels(ctx: ExtensionCommandContext) {
  const role = await ctx.ui.select("Choose a role to configure", ROLES);
  if (!role) return;
  const catalog = ctx.scopedModels.length
    ? ctx.scopedModels.map(({ model }) => model)
    : ctx.modelRegistry.getAvailable();
  const models = catalog
    .filter((model) => ctx.modelRegistry.hasConfiguredAuth(model))
    .map((model) => ({
      label: `${model.name} — ${model.provider}/${model.id}`,
      ref: `${model.provider}/${model.id}`,
    }));
  if (!models.length) {
    ctx.ui.notify("Pi did not report any configured models. No preference was saved.", "warning");
    return;
  }
  const selected = await ctx.ui.select(
    `Choose the preferred model for ${role}`,
    models.map((model) => model.label),
  );
  const modelChoice = models.find((entry) => entry.label === selected);
  if (!modelChoice) return;
  const [provider, ...modelIdParts] = modelChoice.ref.split("/");
  const modelId = modelIdParts.join("/");
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    ctx.ui.notify("The selected model is no longer in Pi's current catalog.", "warning");
    return;
  }
  const supportedLevels = supportedThinkingLevels(model);
  const existing = (await readAssignments())[role];
  const choices = [
    { label: "Use model default", value: "default" as const },
    ...supportedLevels.map((level) => ({ label: level, value: level })),
  ];
  const selectedLevel = await ctx.ui.select(
    `Choose the preferred thinking level for ${role} (current: ${formatThinking(existing.thinkingLevel)})`,
    choices.map((choice) => choice.label),
  );
  const thinking = choices.find((choice) => choice.label === selectedLevel);
  if (!thinking) return;
  const confirmed = await ctx.ui.confirm(
    "Save future-task role preference?",
    `${role} → ${modelChoice.ref}; thinking ${formatThinking(thinking.value)}\nThis affects future Studio workers only. It does not change the current thread. Provider billing depends on the selected account/plan; no fallback is configured.`,
  );
  if (!confirmed) return;
  const roles = await readAssignments();
  roles[role] = {
    model: modelChoice.ref,
    thinkingLevel: thinking.value,
  };
  await writeAssignments(roles);
  ctx.ui.notify(
    `Saved ${role} → ${modelChoice.ref} with ${formatThinking(roles[role].thinkingLevel)} thinking for future Studio tasks.`,
    "info",
  );
}

export default function matthewWayStudio(pi: ExtensionAPI) {
  pi.registerCommand("studio", {
    description:
      "Plan bounded delegated work, choose /studio models, then use /studio start after review",
    async handler(args, ctx) {
      const mode = args.trim().toLowerCase();
      if (mode === "start") {
        try {
          const assignments = formatAssignments(await readAssignments(), ctx);
          pi.sendUserMessage(
            `${STUDIO_START}\n\nCurrent Studio role-to-model preferences, host-checked against Pi's catalog/auth:\n${assignments}\n\nIf the required INDEPENDENT_INSPECTOR route is UNAVAILABLE, mark verification blocked and do not dispatch a substitute or use metered fallback.`,
          );
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (mode === "models") {
        try {
          await chooseRoleModels(ctx);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (mode) {
        pi.sendUserMessage(formatPlan(await readAssignments(), ctx, args));
        return;
      }
      try {
        pi.sendUserMessage(formatPlan(await readAssignments(), ctx));
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
