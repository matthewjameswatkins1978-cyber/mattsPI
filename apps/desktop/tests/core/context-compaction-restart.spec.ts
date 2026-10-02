import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  getSelectedTranscript,
  launchDesktop,
  launchDesktopByExecutable,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  selectSession,
  waitForSelectedSessionReady,
} from "../helpers/electron-app";
import {
  allText,
  scriptedText,
  startScriptedOpenAiServer,
  userText,
  type ScriptedActor,
} from "../helpers/scripted-openai-provider";

const MARKER = "MW-COMPACTION-MARKER-71";
const WARM_UP = "Local runtime warm-up; reply with SESSION-READY.";
const FOLLOW_UP = "After context compaction, report the preserved token only.";
const SESSION_TITLE = "Native context compaction restart";

async function seedOversizedSession(agentDir: string, workspacePath: string, modelId: string) {
  const { SessionManager } = (await import("@earendil-works/pi-coding-agent")) as {
    SessionManager: {
      create(cwd: string): {
        appendMessage(message: {
          role: "user" | "assistant";
          content: string | readonly { type: "text"; text: string }[];
          timestamp: number;
          api?: string;
          provider?: string;
          model?: string;
          stopReason?: string;
          usage?: {
            input: number;
            output: number;
            cacheRead: number;
            cacheWrite: number;
            totalTokens: number;
            cost: {
              input: number;
              output: number;
              cacheRead: number;
              cacheWrite: number;
              total: number;
            };
          };
        }): string;
        appendModelChange(provider: string, modelId: string): string;
        appendSessionInfo(name: string): string;
        getSessionId(): string;
      };
    };
  };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const manager = SessionManager.create(workspacePath);
    manager.appendModelChange("studio-fixture", modelId);
    let timestamp = Date.now();
    const nextTimestamp = () => (timestamp += 1_000);
    const assistantMessage = (content: string) => ({
      role: "assistant" as const,
      content: [{ type: "text" as const, text: content }],
      timestamp: nextTimestamp(),
      api: "openai-completions",
      provider: "studio-fixture",
      model: modelId,
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    manager.appendMessage({
      role: "user",
      content: `Preserve this exact reference token through compaction: ${MARKER}.\n${"early-context-padding ".repeat(180)}`,
      timestamp: nextTimestamp(),
    });
    manager.appendMessage(
      assistantMessage(
        `Acknowledged. The reference token is ${MARKER}.\n${"historical-answer-padding ".repeat(180)}`,
      ),
    );
    for (let index = 0; index < 30; index += 1) {
      manager.appendMessage({
        role: "user",
        content: `Historical question ${index}: ${"context-data ".repeat(180)}`,
        timestamp: nextTimestamp(),
      });
      manager.appendMessage(
        assistantMessage(`Historical answer ${index}: ${"resolved-detail ".repeat(180)}`),
      );
    }
    manager.appendSessionInfo(SESSION_TITLE);
    return manager.getSessionId();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

test("native Pi context compaction preserves a marker across app restart", async () => {
  test.setTimeout(180_000);
  let compactionSummarySawMarker = false;
  let followUpSawMarker = false;
  const actor: ScriptedActor = {
    name: "native-compaction-marker-check",
    matches: (context) => true,
    respond: (context) => {
      const text = allText(context);
      // Pi's compaction summarization requests use SUMMARIZATION_SYSTEM_PROMPT
      // ("You are a context summarization assistant..."); ordinary chat requests
      // use the agent system prompt. Distinguish them before routing.
      const isSummarization = text.includes("context summarization assistant");
      if (userText(context).includes(FOLLOW_UP)) {
        followUpSawMarker = text.includes(MARKER);
        return scriptedText(followUpSawMarker ? MARKER : "MISSING");
      }
      if (isSummarization) {
        // A split-turn compaction issues TWO summarization requests: the
        // retained-history summary (which carries the seeded marker) and a
        // turn-prefix summary of only the in-flight turn (legitimately
        // marker-free). Require the marker on the history summary; answer the
        // turn-prefix summary benignly instead of failing the whole compaction.
        if (text.includes(MARKER)) {
          compactionSummarySawMarker = true;
          return scriptedText(`Compacted history. Preserve reference token ${MARKER}.`);
        }
        return scriptedText("Turn prefix summary: local runtime warm-up exchange only.");
      }
      if (userText(context).includes(WARM_UP)) return scriptedText("SESSION-READY");
      return scriptedText("SESSION-READY");
    },
  };
  const server = await startScriptedOpenAiServer([actor], { includeUsage: true });
  const userDataDir = await makeUserDataDir("pi-gui-context-compaction-");
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("context-compaction-workspace");
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
  const sessionId = await seedOversizedSession(agentDir, workspacePath, server.modelId);
  const launchOptions = {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  } as const;
  const testExecutable = process.env.PI_APP_STUDIO_TEST_EXECUTABLE?.trim();
  const launch = () =>
    testExecutable
      ? launchDesktopByExecutable(testExecutable, userDataDir, launchOptions)
      : launchDesktop(userDataDir, launchOptions);

  let harness = await launch();
  try {
    let window = await harness.firstWindow();
    await selectSession(window, SESSION_TITLE);
    await waitForSelectedSessionReady(window, { sessionId });

    await window.getByTestId("composer").fill(WARM_UP);
    await window.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(
      window.locator(".timeline-item--assistant .message__content").last(),
    ).toContainText("SESSION-READY", { timeout: 30_000 });

    const composer = window.getByTestId("composer");
    await composer.fill("/comp");
    const slashMenu = window.getByTestId("slash-menu");
    await expect(slashMenu).toContainText("Compact");
    await slashMenu.getByRole("button", { name: /Compact/ }).click();
    await expect(composer).toHaveValue("/compact");
    await composer.press("Escape");
    await expect(window.getByTestId("slash-menu")).toHaveCount(0);
    await window.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(composer).toHaveValue("", { timeout: 5_000 });
    await expect
      .poll(
        async () => {
          const transcript = await getSelectedTranscript(window);
          return transcript?.transcript.some(
            (item) =>
              item.kind === "message" &&
              item.role === "compactionSummary" &&
              item.text.includes(MARKER),
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    expect(compactionSummarySawMarker).toBe(true);
    // Split-turn compaction protocol: warm-up chat + retained-history summary +
    // turn-prefix summary. Asserted explicitly (not "2") to match reality.
    expect(server.requestLog()).toHaveLength(3);

    await harness.close();
    harness = await launch();
    window = await harness.firstWindow();
    await selectSession(window, SESSION_TITLE);
    await waitForSelectedSessionReady(window, { sessionId });
    await expect
      .poll(async () => {
        const transcript = await getSelectedTranscript(window);
        return transcript?.transcript.some(
          (item) =>
            item.kind === "message" &&
            item.role === "compactionSummary" &&
            item.text.includes(MARKER),
        );
      })
      .toBe(true);

    await window.getByTestId("composer").fill(FOLLOW_UP);
    await window.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(
      window.locator(".timeline-item--assistant .message__content").last(),
    ).toContainText(MARKER, { timeout: 30_000 });
    expect(followUpSawMarker).toBe(true);
    // +1 for the post-restart follow-up chat request.
    expect(server.requestLog()).toHaveLength(4);
    console.log(
      JSON.stringify({
        provider: "local-scripted-fixture",
        compactionCommand: "Pi native /compact after local runtime warm-up",
        summaryIncludedMarker: compactionSummarySawMarker,
        persistedAcrossRestart: true,
        followUpContextIncludedMarker: followUpSawMarker,
        externalProviderRequests: 0,
      }),
    );
  } finally {
    await harness.close();
    await server.close();
  }
});
