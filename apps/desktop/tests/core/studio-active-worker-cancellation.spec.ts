import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  seedAgentDir,
  writeProjectExtension,
} from "../helpers/electron-app";

const workerHoldMarker = "STUDIO_CANCELLATION_TEST_WORKER_HOLD";
const coordinatorDispatchMarker = "CANCEL_TEST_CREATE_NATIVE_CHILD";
const studioCommandFixture = String.raw`
export default function studioCommandFixture(pi) {
  pi.registerCommand("studio", {
    description: "Deterministic Studio start command fixture",
    handler: async (args, ctx) => {
      ctx.ui.setEditorText(args.trim() === "start" ? "STUDIO_START_HANDLED" : "STUDIO_PLAN_HANDLED");
    },
  });
}
`;

interface ProviderMessage {
  readonly content?: unknown;
  readonly role?: string;
  readonly tool_calls?: readonly {
    readonly function?: { readonly name?: string };
  }[];
}

interface ProviderRequest {
  readonly model?: string;
  readonly messages?: readonly ProviderMessage[];
}

interface CancellationProvider {
  readonly baseUrl: string;
  readonly modelId: string;
  readonly workerRequestStarted: Promise<void>;
  readonly workerRequestAborted: Promise<void>;
  requestEvents(): readonly string[];
  close(): Promise<void>;
}

async function requestBody(request: IncomingMessage): Promise<ProviderRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    else if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as ProviderRequest;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) =>
      part && typeof part === "object" && "text" in part
        ? String((part as { readonly text?: unknown }).text ?? "")
        : "",
    )
    .join("");
}

function allMessageText(messages: readonly ProviderMessage[]): string {
  return messages.map(({ content }) => contentText(content)).join("\n");
}

function calledToolNames(messages: readonly ProviderMessage[]): Set<string> {
  return new Set(
    messages.flatMap((message) =>
      (message.tool_calls ?? [])
        .map(({ function: fn }) => fn?.name)
        .filter((name): name is string => typeof name === "string"),
    ),
  );
}

function writeSse(response: ServerResponse, model: string, body: Record<string, unknown>): void {
  const id = `chatcmpl-cancel-test-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  response.writeHead(200, {
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
  });
  response.write(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant", ...body }, finish_reason: null }],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: body.tool_calls ? "tool_calls" : "stop" }],
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

function startCancellationProvider(): Promise<CancellationProvider> {
  const modelId = "studio-cancellation-fixture";
  let resolveWorkerStarted = () => {};
  let resolveWorkerAborted = () => {};
  let workerStarted = false;
  let workerAborted = false;
  const events: string[] = [];
  const workerRequestStarted = new Promise<void>((resolve) => {
    resolveWorkerStarted = resolve;
  });
  const workerRequestAborted = new Promise<void>((resolve) => {
    resolveWorkerAborted = resolve;
  });
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && (request.url ?? "").endsWith("/models")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: modelId }] }));
        return;
      }
      if (request.method !== "POST" || !(request.url ?? "").endsWith("/chat/completions")) {
        response.writeHead(404);
        response.end();
        return;
      }

      const body = await requestBody(request);
      const messages = body.messages ?? [];
      const model = typeof body.model === "string" ? body.model : modelId;
      const joinedText = allMessageText(messages);
      const tools = calledToolNames(messages);
      events.push(
        JSON.stringify({
          hasStartCommand: joinedText.includes("/studio start"),
          hasWorkerMarker: messages.some(
            (message) =>
              message.role === "user" && contentText(message.content).includes(workerHoldMarker),
          ),
          calledTools: [...tools],
          messageCount: messages.length,
        }),
      );
      if (
        messages.some(
          (message) =>
            message.role === "user" && contentText(message.content).includes(workerHoldMarker),
        )
      ) {
        if (!workerStarted) {
          workerStarted = true;
          resolveWorkerStarted();
        }
        await new Promise<void>((resolve) => {
          response.once("close", () => {
            if (!workerAborted) {
              workerAborted = true;
              resolveWorkerAborted();
            }
            resolve();
          });
        });
        return;
      }

      if (joinedText.includes(coordinatorDispatchMarker) && !tools.has("list_studio_runs")) {
        writeSse(response, model, {
          tool_calls: [
            {
              index: 0,
              id: "call_cancel_test_list_runs",
              type: "function",
              function: { name: "list_studio_runs", arguments: "{}" },
            },
          ],
        });
        return;
      }
      if (joinedText.includes(coordinatorDispatchMarker) && !tools.has("create_child_thread")) {
        writeSse(response, model, {
          tool_calls: [
            {
              index: 0,
              id: "call_cancel_test_create_worker",
              type: "function",
              function: {
                name: "create_child_thread",
                arguments: JSON.stringify({
                  prompt: `Run the cancellation fixture task. Include ${workerHoldMarker} in your task process and remain active.`,
                  task_id: "studio-cancel-in-flight-worker",
                  role: "IMPLEMENTER",
                  environment: "worktree",
                }),
              },
            },
          ],
        });
        return;
      }
      writeSse(response, model, { content: "The delegated worker is active." });
    })().catch((error: unknown) => {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: error instanceof Error ? error.message : String(error) },
        }),
      );
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelId,
        workerRequestStarted,
        workerRequestAborted,
        requestEvents: () => [...events],
        close: async () => {
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((done, fail) =>
            server.close((error) => (error ? fail(error) : done())),
          );
        },
      });
    });
  });
}

test("Studio Stop cancels a native child while its model request is in flight", async () => {
  test.setTimeout(120_000);
  const provider = await startCancellationProvider();
  const userDataDir = await makeUserDataDir("pi-gui-studio-active-worker-cancel-");
  const workspacePath = await makeGitWorkspace("studio-active-worker-cancel");
  await writeProjectExtension(workspacePath, "studio-command-fixture.ts", studioCommandFixture);
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: [`studio-fixture/${provider.modelId}`],
  });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(agentDir, "settings.json"),
    `${JSON.stringify(
      {
        defaultProvider: "studio-fixture",
        defaultModel: provider.modelId,
        enabledModels: [`studio-fixture/${provider.modelId}`],
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
            baseUrl: provider.baseUrl,
            api: "openai-completions",
            apiKey: "unused",
            models: [{ id: provider.modelId }],
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
    await createNamedThread(window, "Studio cancellation coordinator");
    await window.getByTestId("sidebar-studio").click();
    await window
      .getByLabel("Specification or implementation packet")
      .fill("Prove that Stop cancels an active child model request in the native Studio runtime.");
    await window.getByRole("button", { name: "Prepare in current thread" }).click();
    await window.getByTestId("sidebar-studio").click();
    await window.getByRole("button", { name: "Start in prepared thread" }).click();
    await expect
      .poll(async () => (await getDesktopState(window)).studioRuns[0]?.status)
      .toBe("running");
    await window
      .getByTestId("composer")
      .fill(
        `${coordinatorDispatchMarker}: Start one bounded child worker and leave its task in flight for the Studio Stop check.`,
      );
    await window.getByRole("button", { name: "Send message", exact: true }).click();

    let workerRequestTimeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        provider.workerRequestStarted,
        new Promise<never>((_resolve, reject) => {
          workerRequestTimeout = setTimeout(
            () =>
              reject(
                new Error(
                  `Timed out waiting for the child model request. Provider events: ${provider.requestEvents().join(" | ")}`,
                ),
              ),
            30_000,
          );
        }),
      ]);
    } finally {
      if (workerRequestTimeout) clearTimeout(workerRequestTimeout);
    }
    await expect
      .poll(async () => (await getDesktopState(window)).orchestrationChildren.length, {
        timeout: 30_000,
      })
      .toBe(1);
    const activeChild = (await getDesktopState(window)).orchestrationChildren[0];
    expect(activeChild).toMatchObject({
      taskId: "studio-cancel-in-flight-worker",
      role: "IMPLEMENTER",
      environment: "worktree",
      status: "running",
      model: { provider: "studio-fixture", modelId: provider.modelId },
    });

    await window.getByTestId("sidebar-studio").click();
    await window.getByRole("button", { name: "Stop run and cancel workers" }).click();
    await expect
      .poll(async () => (await getDesktopState(window)).studioRuns[0]?.status)
      .toBe("stopped");
    await provider.workerRequestAborted;
    await expect
      .poll(async () => {
        const child = (await getDesktopState(window)).orchestrationChildren[0];
        return child?.status;
      })
      .not.toBe("running");
    console.log(
      JSON.stringify({
        nativeChildCreated: true,
        childModelRoute: `${activeChild?.model?.provider}/${activeChild?.model?.modelId}`,
        childWorktree: activeChild?.worktreePath,
        stoppedStudioRun: true,
        inFlightProviderRequestAborted: true,
        provider: "local-stalled-openai-compatible-fixture",
      }),
    );
  } finally {
    await harness.close();
    await provider.close();
  }
});
