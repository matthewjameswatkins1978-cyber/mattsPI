import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { StudioRun } from "../../contracts/studio-runs";

export const createChildThreadToolName = "create_child_thread";
export const createChildThreadAction = "pi_gui_create_child_thread";
export const listThreadsToolName = "list_threads";
export const listThreadsAction = "pi_gui_list_threads";
export const readThreadToolName = "read_thread";
export const readThreadAction = "pi_gui_read_thread";
export const sendMessageToThreadToolName = "send_message_to_thread";
export const sendMessageToThreadAction = "pi_gui_send_message_to_thread";
export const waitForChildThreadsToolName = "wait_for_child_threads";
export const waitForChildThreadsAction = "pi_gui_wait_for_child_threads";
export const saveStudioRunToolName = "save_studio_run";
export const saveStudioRunAction = "pi_gui_save_studio_run";
export const listStudioRunsToolName = "list_studio_runs";
export const listStudioRunsAction = "pi_gui_list_studio_runs";

export interface CreateChildThreadToolDetails {
  readonly action: typeof createChildThreadAction;
  readonly prompt: string;
  readonly worktreePath?: string;
  readonly branchName?: string;
  readonly taskId?: string;
  readonly role?: string;
  readonly provider?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
  readonly environment?: "local" | "worktree";
  readonly childThreadId?: string;
  readonly childWorkspaceId?: string;
  readonly childSessionId?: string;
  readonly title?: string;
  readonly deliveryStatus?: "running" | "responded";
  readonly error?: string;
}

export interface CreateChildThreadOptions {
  readonly taskId?: string;
  readonly role?: string;
  readonly provider?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
  readonly environment?: "local" | "worktree";
}

export interface OrchestrationThreadListEntry {
  readonly threadId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly title: string;
  readonly status: string;
  readonly relationship: "current" | "child" | "workspace";
  readonly updatedAt: string;
  readonly preview: string;
  readonly childThreadId?: string;
  readonly supervisionGate?: "continue" | "wake" | "stop";
  readonly supervisionReason?: string;
  readonly nextSupervisionRunAt?: string;
  readonly role?: string;
  readonly provider?: string;
  readonly modelId?: string;
  readonly environment?: "local" | "worktree";
}

export interface OrchestrationThreadTranscriptMessage {
  readonly id: string;
  readonly role: "parent" | "child" | "system";
  readonly text: string;
  readonly createdAt: string;
}

export interface ListThreadsToolDetails {
  readonly action: typeof listThreadsAction;
  readonly threads?: readonly OrchestrationThreadListEntry[];
  readonly error?: string;
}

export interface ReadThreadToolDetails {
  readonly action: typeof readThreadAction;
  readonly threadId: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly title?: string;
  readonly status?: string;
  readonly childThreadId?: string;
  readonly goal?: string;
  readonly messages?: readonly OrchestrationThreadTranscriptMessage[];
  readonly error?: string;
}

export interface SendMessageToThreadToolDetails {
  readonly action: typeof sendMessageToThreadAction;
  readonly threadId: string;
  readonly message: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly status?: "queued" | "sent";
  readonly queuedMessageCount?: number;
  readonly error?: string;
}

export interface WaitForChildThreadsToolDetails {
  readonly action: typeof waitForChildThreadsAction;
  readonly threads?: readonly Pick<
    OrchestrationThreadListEntry,
    "threadId" | "title" | "status" | "role" | "provider" | "modelId"
  >[];
  readonly timedOut?: boolean;
  readonly aborted?: boolean;
  readonly error?: string;
}

export interface SaveStudioRunToolDetails {
  readonly action: typeof saveStudioRunAction;
  readonly runId?: string;
  readonly revision?: number;
  readonly status?: string;
  readonly error?: string;
}

export interface ListStudioRunsToolDetails {
  readonly action: typeof listStudioRunsAction;
  readonly project: {
    readonly workspaceId: string;
    readonly repositoryPath: string;
  };
  readonly runs: readonly StudioRun[];
}

export interface OrchestrationRuntimeBridge {
  readonly createChildThread: (
    ctx: ExtensionContext,
    input: { readonly prompt: string; readonly toolCallId: string } & CreateChildThreadOptions,
  ) => Promise<AgentToolResult<CreateChildThreadToolDetails>>;
  readonly listThreads: (ctx: ExtensionContext) => Promise<AgentToolResult<ListThreadsToolDetails>>;
  readonly readThread: (
    ctx: ExtensionContext,
    threadId: string,
  ) => Promise<AgentToolResult<ReadThreadToolDetails>>;
  readonly sendMessageToThread: (
    ctx: ExtensionContext,
    input: { readonly threadId: string; readonly message: string },
  ) => Promise<AgentToolResult<SendMessageToThreadToolDetails>>;
  readonly waitForChildThreads: (
    ctx: ExtensionContext,
    input: {
      readonly threadIds: readonly string[];
      readonly timeoutMs: number;
      readonly signal: AbortSignal;
    },
  ) => Promise<AgentToolResult<WaitForChildThreadsToolDetails>>;
  readonly saveStudioRun: (
    ctx: ExtensionContext,
    run: StudioRun,
  ) => Promise<AgentToolResult<SaveStudioRunToolDetails>>;
  readonly listStudioRuns: (
    ctx: ExtensionContext,
  ) => Promise<AgentToolResult<ListStudioRunsToolDetails>>;
}

type OrchestrationToolDetails =
  | CreateChildThreadToolDetails
  | ListThreadsToolDetails
  | ReadThreadToolDetails
  | SendMessageToThreadToolDetails
  | WaitForChildThreadsToolDetails
  | SaveStudioRunToolDetails
  | ListStudioRunsToolDetails;

function createCreateChildThreadTool(
  bridge: OrchestrationRuntimeBridge,
): ToolDefinition<any, OrchestrationToolDetails> {
  return {
    name: createChildThreadToolName,
    label: "Create child thread",
    description:
      "Start a separate pi-gui child thread for a delegated investigation or implementation task.",
    promptSnippet: "create_child_thread: start a separate pi-gui child thread for delegated work.",
    promptGuidelines: [
      "Use create_child_thread when the user asks you to spin up, delegate to, or run a separate child thread.",
      "Keep the child prompt concrete and self-contained so the user can inspect the resulting thread.",
      "For Studio work, include a stable task_id derived from the run, milestone, worker purpose and repair attempt. Reuse exactly the same id when replaying that dispatch; do not invent a new id for a duplicate event.",
    ],
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Concrete instructions for the child thread.",
        },
        task_id: { type: "string", description: "Stable identifier for this delegated task." },
        role: {
          type: "string",
          enum: [
            "COORDINATOR",
            "IMPLEMENTER",
            "FAST_WORKER",
            "RESEARCHER",
            "INDEPENDENT_INSPECTOR",
            "RELEASE_ENGINEER",
          ],
          description: "Logical role, independent of model identity.",
        },
        provider: { type: "string", description: "Explicit configured Pi provider id." },
        model_id: { type: "string", description: "Explicit model id under provider." },
        thinking_level: { type: "string", description: "Provider-supported thinking level." },
        environment: {
          type: "string",
          enum: ["local", "worktree"],
          description: "Use worktree for independent writing tasks.",
        },
      },
      required: ["prompt"],
    },
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      const prompt = createChildThreadPromptFromParams(params);
      if (!prompt) {
        throw new Error("create_child_thread requires a non-empty prompt.");
      }
      return bridge.createChildThread(ctx, {
        prompt,
        toolCallId,
        ...createChildThreadOptionsFromParams(params),
      });
    },
  };
}

function createListThreadsTool(
  bridge: OrchestrationRuntimeBridge,
): ToolDefinition<any, OrchestrationToolDetails> {
  return {
    name: listThreadsToolName,
    label: "List threads",
    description: "List pi-gui threads visible to the current workspace and parent thread.",
    promptSnippet:
      "list_threads: list relevant pi-gui threads for the current workspace and parent context.",
    promptGuidelines: [
      "Use list_threads before reading or messaging another pi-gui thread when you need the exact thread id.",
      "Use the returned thread id with read_thread or send_message_to_thread.",
    ],
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return bridge.listThreads(ctx);
    },
  };
}

function createReadThreadTool(
  bridge: OrchestrationRuntimeBridge,
): ToolDefinition<any, OrchestrationToolDetails> {
  return {
    name: readThreadToolName,
    label: "Read thread",
    description: "Read a pi-gui thread transcript or child thread summary by id.",
    promptSnippet: "read_thread: read a pi-gui thread transcript by id.",
    promptGuidelines: [
      "Use read_thread with a thread id returned by list_threads or create_child_thread.",
      "Prefer reading a child thread before summarizing its status back to the parent.",
    ],
    parameters: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          description: "Thread id, child thread id, or session id to read.",
        },
      },
      required: ["thread_id"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const threadId = threadIdFromParams(params);
      if (!threadId) {
        return {
          content: [{ type: "text", text: "read_thread requires a thread_id." }],
          details: {
            action: readThreadAction,
            threadId: "",
            error: "read_thread requires a thread_id.",
          },
        };
      }
      return bridge.readThread(ctx, threadId);
    },
  };
}

function createSendMessageToThreadTool(
  bridge: OrchestrationRuntimeBridge,
): ToolDefinition<any, OrchestrationToolDetails> {
  return {
    name: sendMessageToThreadToolName,
    label: "Send message to thread",
    description: "Send a follow-up message to an existing pi-gui thread.",
    promptSnippet: "send_message_to_thread: send a follow-up to an existing pi-gui thread.",
    promptGuidelines: [
      "Use send_message_to_thread to follow up with an existing child or sibling pi-gui thread.",
      "Use a thread id returned by list_threads or create_child_thread.",
    ],
    parameters: {
      type: "object",
      properties: {
        thread_id: {
          type: "string",
          description: "Thread id, child thread id, or session id to message.",
        },
        message: {
          type: "string",
          description: "Follow-up message to send.",
        },
      },
      required: ["thread_id", "message"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const threadId = threadIdFromParams(params);
      const message = messageFromParams(params);
      if (!threadId || !message) {
        return {
          content: [
            { type: "text", text: "send_message_to_thread requires thread_id and message." },
          ],
          details: {
            action: sendMessageToThreadAction,
            threadId: threadId ?? "",
            message: message ?? "",
            error: "send_message_to_thread requires thread_id and message.",
          },
        };
      }
      return bridge.sendMessageToThread(ctx, { threadId, message });
    },
  };
}

function createWaitForChildThreadsTool(
  bridge: OrchestrationRuntimeBridge,
): ToolDefinition<any, OrchestrationToolDetails> {
  return {
    name: waitForChildThreadsToolName,
    label: "Wait for child threads",
    description:
      "Wait up to 60 seconds for one or more delegated child threads to finish or fail, then continue coordinating.",
    promptSnippet:
      "wait_for_child_threads: wait for child completion before inspecting and accepting results.",
    promptGuidelines: [
      "Use wait_for_child_threads after dispatching child work; inspect finished work with read_thread.",
      "A timeout is a status update, not evidence of completion. Wait again or handle a stalled worker.",
    ],
    parameters: {
      type: "object",
      properties: {
        thread_ids: {
          type: "array",
          items: { type: "string" },
          description: "Child thread ids returned by create_child_thread.",
        },
        timeout_ms: {
          type: "number",
          description: "Maximum wait for this call, from 1 to 60000 milliseconds.",
        },
      },
      required: ["thread_ids"],
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const threadIds = stringArrayParam(params, "thread_ids");
      if (!threadIds?.length) {
        throw new Error("wait_for_child_threads requires at least one thread_id.");
      }
      const timeoutMs = numberParam(params, "timeout_ms") ?? 60_000;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
        throw new Error("timeout_ms must be an integer between 1 and 60000.");
      }
      return bridge.waitForChildThreads(ctx, {
        threadIds,
        timeoutMs,
        signal: signal ?? new AbortController().signal,
      });
    },
  };
}

function createSaveStudioRunTool(
  bridge: OrchestrationRuntimeBridge,
): ToolDefinition<any, OrchestrationToolDetails> {
  const milestoneProperties = {
    id: { type: "string", description: "Stable milestone identifier." },
    title: { type: "string" },
    instruction: { type: "string", description: "Bounded, self-contained milestone packet." },
    dependsOn: { type: "array", items: { type: "string" } },
    status: {
      type: "string",
      enum: ["queued", "running", "verifying", "repair-needed", "complete", "blocked", "cancelled"],
    },
    workerThreadIds: { type: "array", items: { type: "string" } },
    worktreeIds: { type: "array", items: { type: "string" } },
    checkpointSha: { type: "string" },
    pullRequestUrl: { type: "string" },
    githubCheckpoints: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          repository: { type: "string" },
          branch: { type: "string" },
          pullRequestUrl: { type: "string" },
          baseSha: { type: "string" },
          headSha: { type: "string" },
          pushedAt: { type: "string" },
          reviewHistory: {
            type: "array",
            maxItems: 100,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                decision: { type: "string", enum: ["changes-requested", "accepted", "merged"] },
                reviewedHeadSha: { type: "string" },
                recordedAt: { type: "string" },
                source: { type: "string", enum: ["matthew", "github-api"] },
                mergeCommitSha: { type: "string" },
                mergedAt: { type: "string" },
              },
              required: ["decision", "reviewedHeadSha", "recordedAt", "source"],
            },
          },
        },
        required: [
          "repository",
          "branch",
          "pullRequestUrl",
          "baseSha",
          "headSha",
          "pushedAt",
          "reviewHistory",
        ],
      },
    },
    updatedAt: { type: "string" },
  };
  return {
    name: saveStudioRunToolName,
    label: "Save Studio run",
    description:
      "Persist the current Matthew Way Studio run plan and lifecycle state for this project. Call list_studio_runs first and copy project.workspaceId and project.repositoryPath exactly; never invent project identity. The run must use the complete version-1 StudioRun schema shown below.",
    promptSnippet: "save_studio_run: persist a project-scoped Studio plan and progress update.",
    promptGuidelines: [
      "Call list_studio_runs before saving to obtain the current project's exact workspaceId and repositoryPath. Use a complete StudioRun object: id, workspaceId, repositoryPath, specification (string), mode (observed or autonomous), status (draft/running/paused/stopped/completed/blocked), milestones, createdAt, updatedAt, and integer revision. Each milestone requires id, title, instruction, dependsOn, status, workerThreadIds, worktreeIds, and updatedAt; checkpointSha, pullRequestUrl, and append-only githubCheckpoints are optional. The application owns the delivery policy for newly planned milestones; include no deliveryRequirement field. Internal milestone complete means internally accepted only; never infer Lucy acceptance or merge from it.",
      "Preserve specificationRevision and the complete corrections array when updating an existing run. A prepared correction is not applied until its impact and affected dependencies have been reconciled against the repository and active workers.",
      "Studio correction history is append-only. Mark prepared as sent only after acting on the correction packet. Mark sent as applied only after reconciling the affected milestones; include a concise reconciliationSummary. Existing milestone IDs, instructions and dependencies are immutable: progress affected work through the normal lifecycle and append replacement milestones with new IDs when the plan changes.",
      "Save the full original specification and milestone/dependency plan before dispatching child work.",
      "Keep at most two Studio child workers active at once. Worker role and provider/model are separate choices: use catalog-confirmed free or subscription routes, pass provider and model_id together only when explicitly routing, and never silently switch to a metered route after an error or quota limit.",
      "Treat a worker's completion message as a claim, not acceptance. Move that milestone to verifying, then create a separate child thread with role independent-inspector to inspect the actual repository diff and run the specification-relevant checks. Read the inspector thread's result and evidence before deciding the milestone outcome; never use the implementation worker's own review as independent verification.",
      "Pi blocks the transition to complete unless a linked independent-inspector child from this coordinator has completed, its final report starts with PASS, its runtime evidence contains successful Git diff/status inspection and a test/check command, and this coordinator has read the inspector output. Wait for all five persisted signals; do not remove the inspector id to bypass the gate. The inspector must finish with exactly one outcome: PASS, FAIL, INCONCLUSIVE, or STOP.",
      "Accept internal verification only on PASS with the inspected revision, relevant checks and results, changed-file scope, and failure/recovery paths accounted for. INCONCLUSIVE is not PASS. On FAIL, move the milestone to repair-needed and send the worker a bounded evidence-backed repair packet; allow at most two repair attempts, then mark the milestone blocked and explain the unresolved evidence.",
      "After each verification or repair, reconcile the actual repository and worker state, then save the updated milestone status and worker thread ids. Do not claim verification, commit, push, PR, or merge until the corresponding local or GitHub evidence has been observed. A pending Lucy review does not stop other dependency-ready milestones; continue them only on the correct independent or explicitly stacked branch.",
      "Update the persisted run after every material milestone, worker, verification, review, correction, or blocker change.",
      "Use monotonically increasing revisions for updates; never overwrite an unknown newer revision.",
    ],
    parameters: {
      type: "object",
      properties: {
        run: {
          type: "object",
          additionalProperties: false,
          description:
            "A complete version-1 StudioRun record. Copy workspaceId and repositoryPath exactly from list_studio_runs.project.",
          properties: {
            id: { type: "string" },
            workspaceId: { type: "string" },
            repositoryPath: { type: "string" },
            specification: {
              type: "string",
              description: "The complete original master specification.",
            },
            specificationRevision: { type: "integer", minimum: 1 },
            corrections: {
              type: "array",
              maxItems: 100,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  id: { type: "string" },
                  specificationRevision: { type: "integer", minimum: 2 },
                  instruction: { type: "string" },
                  affectedMilestoneIds: { type: "array", items: { type: "string" } },
                  status: { type: "string", enum: ["prepared", "sent", "applied", "superseded"] },
                  reconciliationSummary: { type: "string" },
                  recordedAt: { type: "string" },
                },
                required: [
                  "id",
                  "specificationRevision",
                  "instruction",
                  "affectedMilestoneIds",
                  "status",
                  "recordedAt",
                ],
              },
            },
            mode: { type: "string", enum: ["observed", "autonomous"] },
            status: {
              type: "string",
              enum: ["draft", "running", "paused", "stopped", "completed", "blocked"],
            },
            milestones: {
              type: "array",
              maxItems: 100,
              items: {
                type: "object",
                additionalProperties: false,
                properties: milestoneProperties,
                required: [
                  "id",
                  "title",
                  "instruction",
                  "dependsOn",
                  "status",
                  "workerThreadIds",
                  "worktreeIds",
                  "updatedAt",
                ],
              },
            },
            createdAt: { type: "string" },
            updatedAt: { type: "string" },
            revision: { type: "integer", minimum: 1 },
            lastError: { type: "string" },
          },
          required: [
            "id",
            "workspaceId",
            "repositoryPath",
            "specification",
            "mode",
            "status",
            "milestones",
            "createdAt",
            "updatedAt",
            "revision",
          ],
        },
      },
      required: ["run"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isRecord(params) || !isRecord(params.run)) {
        throw new Error("save_studio_run requires a complete run object.");
      }
      return bridge.saveStudioRun(ctx, params.run as unknown as StudioRun);
    },
  };
}

function createListStudioRunsTool(
  bridge: OrchestrationRuntimeBridge,
): ToolDefinition<any, OrchestrationToolDetails> {
  return {
    name: listStudioRunsToolName,
    label: "List Studio runs",
    description:
      "Load the current project's exact workspace identity and saved Matthew Way Studio plans.",
    promptSnippet:
      "list_studio_runs: get exact project workspaceId/repositoryPath and restore durable Studio plan state.",
    promptGuidelines: [
      "Load saved Studio runs before planning, starting, updating, or resuming project work. The result includes project.workspaceId and project.repositoryPath; copy these exact values into save_studio_run and do not guess them. If a run is paused with a restart recovery note, reconcile the current Pi coordinator/worker threads, repository state, verification results, and GitHub checkpoints before dispatching. Preserve completed and already-running milestones; do not duplicate their work.",
      "Reconcile persisted worker and checkpoint identities against actual threads and Git state before dispatching or replaying work.",
    ],
    parameters: { type: "object", properties: {} },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return bridge.listStudioRuns(ctx);
    },
  };
}

export function createOrchestrationRuntimeTools(
  bridge: OrchestrationRuntimeBridge,
): readonly ToolDefinition<any, OrchestrationToolDetails>[] {
  return [
    createCreateChildThreadTool(bridge),
    createListThreadsTool(bridge),
    createReadThreadTool(bridge),
    createSendMessageToThreadTool(bridge),
    createWaitForChildThreadsTool(bridge),
    createListStudioRunsTool(bridge),
    createSaveStudioRunTool(bridge),
  ];
}

export function createOrchestrationRuntimeExtension(
  bridge: OrchestrationRuntimeBridge,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    for (const tool of createOrchestrationRuntimeTools(bridge)) {
      pi.registerTool(tool);
    }
  };
}

export function createChildThreadPromptFromParams(params: unknown): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
  return prompt || undefined;
}

export function createChildThreadOptionsFromParams(params: unknown): CreateChildThreadOptions {
  if (!isRecord(params)) return {};
  const role = stringParam(params, "role");
  const environment = stringParam(params, "environment");
  const thinkingLevel =
    stringParam(params, "thinking_level") ?? stringParam(params, "thinkingLevel");
  return {
    ...((stringParam(params, "task_id") ?? stringParam(params, "taskId"))
      ? { taskId: stringParam(params, "task_id") ?? stringParam(params, "taskId") }
      : {}),
    ...(role ? { role } : {}),
    ...(stringParam(params, "provider") ? { provider: stringParam(params, "provider") } : {}),
    ...((stringParam(params, "model_id") ?? stringParam(params, "modelId"))
      ? { modelId: stringParam(params, "model_id") ?? stringParam(params, "modelId") }
      : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(environment === "local" || environment === "worktree" ? { environment } : {}),
  };
}

export function createChildThreadPromptFromToolOutput(output: unknown): string | undefined {
  if (!isRecord(output) || !isRecord(output.details)) {
    return undefined;
  }
  if (output.details.action !== createChildThreadAction) {
    return undefined;
  }
  return createChildThreadPromptFromParams(output.details);
}

export function listThreadsRequestedFromToolOutput(output: unknown): boolean {
  return toolOutputDetails(output)?.action === listThreadsAction;
}

export function readThreadIdFromToolOutput(output: unknown): string | undefined {
  const details = toolOutputDetails(output);
  if (details?.action !== readThreadAction) {
    return undefined;
  }
  return threadIdFromParams(details);
}

export function sendMessageToThreadFromToolOutput(
  output: unknown,
): { readonly threadId: string; readonly message: string } | undefined {
  const details = toolOutputDetails(output);
  if (details?.action !== sendMessageToThreadAction) {
    return undefined;
  }
  const threadId = threadIdFromParams(details);
  const message = messageFromParams(details);
  if (!threadId || !message) {
    return undefined;
  }
  return { threadId, message };
}

function toolOutputDetails(output: unknown): Record<string, unknown> | undefined {
  if (!isRecord(output) || !isRecord(output.details)) {
    return undefined;
  }
  return output.details;
}

function threadIdFromParams(params: unknown): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const threadId =
    stringParam(params, "thread_id") ??
    stringParam(params, "threadId") ??
    stringParam(params, "id");
  return threadId || undefined;
}

function messageFromParams(params: unknown): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const message = stringParam(params, "message") ?? stringParam(params, "text");
  return message || undefined;
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function stringArrayParam(params: unknown, key: string): readonly string[] | undefined {
  if (!isRecord(params) || !Array.isArray(params[key])) return undefined;
  const values = params[key] as unknown[];
  if (!values.every((value) => typeof value === "string" && value.trim().length > 0)) {
    return undefined;
  }
  return [...new Set(values.map((value) => (value as string).trim()))];
}

function numberParam(params: unknown, key: string): number | undefined {
  if (!isRecord(params)) return undefined;
  const value = params[key];
  return typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
