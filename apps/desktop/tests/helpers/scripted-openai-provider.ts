import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Deterministic local OpenAI-compatible provider fixture.
 *
 * The server scripts every model turn: each incoming chat-completions request is
 * routed to the first actor whose `matches` accepts the conversation, and the
 * actor's response is streamed back as SSE (plain text or a single tool call).
 * Real Pi sessions execute the returned tool calls natively, so this drives real
 * runtime behavior without any external provider, credentials, or spend.
 */

export interface ScriptedToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export type ScriptedResponse =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly toolCall: ScriptedToolCall };

export function scriptedText(text: string): ScriptedResponse {
  return { kind: "text", text };
}

export function scriptedToolCall(name: string, args: Record<string, unknown>): ScriptedResponse {
  return { kind: "tool", toolCall: { name, args } };
}

export interface ScriptedToolCallMessagePart {
  readonly id?: string;
  readonly type?: string;
  readonly function?: { readonly name?: string; readonly arguments?: string };
}

export interface ScriptedMessage {
  readonly role?: string;
  readonly content?: unknown;
  readonly tool_calls?: readonly ScriptedToolCallMessagePart[];
  readonly tool_call_id?: string;
  readonly name?: string;
}

export interface ScriptedRequestContext {
  readonly messages: readonly ScriptedMessage[];
  readonly toolNames: readonly string[];
  readonly model: string;
}

export interface ScriptedActor {
  readonly name: string;
  matches(context: ScriptedRequestContext): boolean;
  respond(context: ScriptedRequestContext): ScriptedResponse;
}

export interface ScriptedRequestLogEntry {
  readonly index: number;
  readonly actor: string;
  readonly at: string;
  readonly response: ScriptedResponse;
  readonly messages: readonly ScriptedMessage[];
}

export interface ScriptedOpenAiServer {
  readonly baseUrl: string;
  readonly modelId: string;
  requestLog(): readonly ScriptedRequestLogEntry[];
  close(): Promise<void>;
}

export function messageText(message: ScriptedMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : part && typeof part === "object" && "text" in part
            ? String((part as { text?: unknown }).text ?? "")
            : "",
      )
      .join("");
  }
  return "";
}

export function userText(context: ScriptedRequestContext): string {
  return context.messages
    .filter((message) => message.role === "user")
    .map(messageText)
    .join("\n");
}

export function allText(context: ScriptedRequestContext): string {
  return context.messages.map(messageText).join("\n");
}

export function assistantTurnCount(context: ScriptedRequestContext): number {
  return context.messages.filter((message) => message.role === "assistant").length;
}

export interface ScriptedToolExchange {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly resultText: string;
}

/** Ordered (tool call, tool result) pairs reconstructed from the conversation. */
export function toolExchanges(context: ScriptedRequestContext): readonly ScriptedToolExchange[] {
  const resultsByCallId = new Map<string, string>();
  for (const message of context.messages) {
    if (message.role === "tool" && typeof message.tool_call_id === "string") {
      resultsByCallId.set(message.tool_call_id, messageText(message));
    }
  }
  const exchanges: ScriptedToolExchange[] = [];
  for (const message of context.messages) {
    if (message.role !== "assistant" || !message.tool_calls) continue;
    for (const call of message.tool_calls) {
      const name = call.function?.name;
      const callId = call.id;
      if (!name || !callId) continue;
      let args: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(call.function?.arguments ?? "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        args = {};
      }
      exchanges.push({ name, args, resultText: resultsByCallId.get(callId) ?? "" });
    }
  }
  return exchanges;
}

export function pickShellTool(toolNames: readonly string[]): string {
  if (toolNames.includes("bash")) return "bash";
  if (toolNames.includes("powershell")) return "powershell";
  throw new Error(
    `Scripted actor needs a shell tool; offered tools were: ${toolNames.join(", ") || "none"}`,
  );
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const value of request) {
    const chunk: unknown = value;
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
    } else {
      throw new Error("Scripted provider received an unsupported request chunk.");
    }
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function sseChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export async function startScriptedOpenAiServer(
  actors: readonly ScriptedActor[],
  options: {
    readonly modelId?: string;
    readonly fallback?: ScriptedActor;
    readonly includeUsage?: boolean;
  } = {},
): Promise<ScriptedOpenAiServer> {
  const modelId = options.modelId ?? "scripted";
  const log: ScriptedRequestLogEntry[] = [];
  let callCounter = 0;
  const sockets = new Set<import("node:net").Socket>();

  const fallback: ScriptedActor = options.fallback ?? {
    name: "fallback",
    matches: () => true,
    respond: () => scriptedText("Acknowledged."),
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    handleRequest(request, response).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? "";
    if (request.method === "GET" && url.endsWith("/models")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: modelId }] }));
      return;
    }
    if (request.method !== "POST" || !url.endsWith("/chat/completions")) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: `Unhandled fixture request: ${url}` } }));
      return;
    }
    const body = await readJsonBody(request);
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const messages = rawMessages as readonly ScriptedMessage[];
    const rawTools = Array.isArray(body.tools) ? body.tools : [];
    const toolNames = rawTools
      .map((tool) => {
        if (tool && typeof tool === "object" && "function" in tool) {
          const fn = (tool as { function?: { name?: unknown } }).function;
          return typeof fn?.name === "string" ? fn.name : "";
        }
        return "";
      })
      .filter(Boolean);
    const context: ScriptedRequestContext = {
      messages,
      toolNames,
      model: typeof body.model === "string" ? body.model : modelId,
    };
    const actor = actors.find((candidate) => candidate.matches(context)) ?? fallback;
    let scripted: ScriptedResponse;
    try {
      scripted = actor.respond(context);
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: `Scripted actor "${actor.name}" failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        }),
      );
      return;
    }
    const usage = options.includeUsage
      ? (() => {
          const promptTokens = Math.ceil(JSON.stringify(messages).length / 4);
          const completionText =
            scripted.kind === "text" ? scripted.text : JSON.stringify(scripted.toolCall.args);
          const completionTokens = Math.ceil(completionText.length / 4);
          return {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          };
        })()
      : undefined;
    log.push({
      index: log.length,
      actor: actor.name,
      at: new Date().toISOString(),
      response: scripted,
      messages,
    });

    const completionId = `chatcmpl-scripted-${callCounter}`;
    const created = Math.floor(Date.now() / 1000);
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    });
    const base = {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: context.model,
    };
    if (scripted.kind === "text") {
      response.write(
        sseChunk({
          ...base,
          choices: [{ index: 0, delta: { role: "assistant", content: scripted.text } }],
        }),
      );
      response.write(
        sseChunk({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }),
      );
    } else {
      const callId = `call_scripted_${callCounter}`;
      callCounter += 1;
      response.write(
        sseChunk({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    index: 0,
                    id: callId,
                    type: "function",
                    function: {
                      name: scripted.toolCall.name,
                      arguments: JSON.stringify(scripted.toolCall.args),
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
      response.write(
        sseChunk({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        }),
      );
    }
    if (usage) {
      response.write(
        sseChunk({
          ...base,
          choices: [],
          usage,
        }),
      );
    }
    response.end("data: [DONE]\n\n");
  }

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    modelId,
    requestLog: () => [...log],
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
