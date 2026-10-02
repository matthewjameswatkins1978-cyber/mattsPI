import { cp, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  getDesktopState,
  launchPackagedDesktop,
  makeUserDataDir,
  makeWorkspace,
} from "../helpers/electron-app";
import { sessionFilePathFromCatalog } from "../helpers/session-file";

test("installed Pi GUI context-mode A/B on the same Studio demo task", async () => {
  test.skip(
    process.env.PI_APP_RUN_CONTEXT_MODE_AB !== "1",
    "Set PI_APP_RUN_CONTEXT_MODE_AB=1 to run two authenticated Qwen Token Plan sessions.",
  );
  test.setTimeout(600_000);

  const sourceAgentDir = join(homedir(), ".pi", "agent");
  const demoSource = resolve(__dirname, "../../../../../studio-demo");
  const task =
    "Follow README.md exactly: inspect the existing source and named test, fix add(2, 3) to return 5, preserve the named test, run npm test, and report the changed file and test result. Use only this workspace. Do not publish or commit.";
  const runs: Array<{
    label: string;
    workspacePath: string;
    usage: number;
    elapsedMs: number;
    modelRoutes: string[];
    toolNames: string[];
    ranNpmTest: boolean;
    toolResultChars: number;
    files: string[];
  }> = [];

  for (const withContextMode of [false, true]) {
    const label = withContextMode ? "context-mode" : "baseline";
    const userDataDir = await makeUserDataDir(`pi-gui-context-mode-${label}-`);
    const agentDir = join(userDataDir, "agent");
    const workspacePath = await makeWorkspace(`studio-demo-${label}`);
    await mkdir(agentDir, { recursive: true });
    await cp(demoSource, workspacePath, { recursive: true, force: true });

    for (const name of ["auth.json", "settings.json", "models.json"]) {
      await copyFile(join(sourceAgentDir, name), join(agentDir, name));
    }
    for (const name of ["mcp-adapter.json", "mcp-cache.json"]) {
      try {
        await copyFile(join(sourceAgentDir, name), join(agentDir, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }

    const settingsPath = join(agentDir, "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    const packages = Array.isArray(settings.packages)
      ? settings.packages.filter((item): item is string => typeof item === "string")
      : [];
    await writeFile(
      settingsPath,
      `${JSON.stringify(
        {
          ...settings,
          defaultProvider: "qwen-token-plan",
          defaultModel: "qwen3.8-max",
          defaultThinkingLevel: "medium",
          enabledModels: ["qwen-token-plan/qwen3.8-max"],
          packages: withContextMode
            ? [
                ...packages.filter((name) => !name.startsWith("npm:context-mode")),
                "npm:context-mode@1.0.169",
              ]
            : packages.filter((name) => !name.startsWith("npm:context-mode")),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const harness = await launchPackagedDesktop(userDataDir, {
      agentDir,
      initialWorkspaces: [workspacePath],
      testMode: "background",
      envOverrides: { CONTEXT_MODE_DIR: join(userDataDir, "context-mode-data") },
    });
    try {
      const window = harness.electronApp.windows()[0] ?? (await harness.electronApp.firstWindow());
      await window.waitForFunction(
        () => Boolean((window as Window & { piApp?: unknown }).piApp),
        undefined,
        { timeout: 45_000 },
      );
      await window
        .getByRole("complementary")
        .getByRole("button", { name: "New thread", exact: true })
        .click();
      await window.getByTestId("new-thread-composer").fill(task);
      const startedAt = Date.now();
      await window.getByRole("button", { name: "Start thread" }).click();
      const assistant = window.locator(".timeline-item--assistant .message__content").last();
      await expect(assistant).toContainText(/test|return|sum/i, { timeout: 300_000 });
      await expect
        .poll(
          async () => {
            const state = await getDesktopState(window);
            const selected = state.workspaces.find(({ id }) => id === state.selectedWorkspaceId);
            const session = selected?.sessions.find(({ id }) => id === state.selectedSessionId);
            return session?.status;
          },
          { timeout: 300_000 },
        )
        .toBe("idle");
      const elapsedMs = Date.now() - startedAt;

      const state = await getDesktopState(window);
      const selected = state.workspaces.find(({ id }) => id === state.selectedWorkspaceId);
      if (!selected || !state.selectedSessionId) throw new Error(`${label}: no selected session`);
      const sessionPath = await sessionFilePathFromCatalog(userDataDir, {
        workspaceId: selected.id,
        sessionId: state.selectedSessionId,
      });
      const lines = (await readFile(sessionPath, "utf8")).split(/\r?\n/).filter(Boolean);
      let usage = 0;
      let toolResultChars = 0;
      const toolNames = new Set<string>();
      const modelRoutes = new Set<string>();
      let ranNpmTest = false;
      for (const line of lines) {
        const entry = JSON.parse(line) as {
          message?: {
            role?: string;
            provider?: string;
            model?: string;
            usage?: { totalTokens?: number };
            content?: Array<{ type?: string; name?: string; text?: string; arguments?: unknown }>;
          };
        };
        if (entry.message?.role === "assistant") {
          usage += entry.message.usage?.totalTokens ?? 0;
          if (entry.message.provider && entry.message.model) {
            modelRoutes.add(`${entry.message.provider}/${entry.message.model}`);
          }
          for (const part of entry.message.content ?? []) {
            if (part.type === "toolCall" && part.name) {
              toolNames.add(part.name);
              if (/npm\s+test/i.test(JSON.stringify(part.arguments ?? ""))) ranNpmTest = true;
            }
          }
        }
        if (entry.message?.role === "toolResult") {
          for (const part of entry.message.content ?? []) {
            if (part.type === "text") toolResultChars += part.text?.length ?? 0;
          }
        }
      }

      const mathSource = await readFile(join(workspacePath, "src", "math.mjs"), "utf8");
      const testFiles = await readFile(join(workspacePath, "src", "math.test.mjs"), "utf8");
      const assistantText = await assistant.innerText();
      const files = [
        ...(mathSource.includes("return left + right") ? ["src/math.mjs fixed"] : []),
        ...(testFiles.includes("add returns the sum of two positive integers")
          ? ["named test preserved"]
          : []),
        ...(assistantText.match(/pass|ok|tests?\s*\d+/gi) ? ["test evidence stated"] : []),
      ];
      expect(mathSource).toContain("return left + right");
      expect(testFiles).toContain("add returns the sum of two positive integers");
      expect(assistantText).toMatch(/pass|ok|tests?\s*\d+/i);
      expect([...modelRoutes].every((route) => route === "qwen-token-plan/qwen3.8-max")).toBe(true);
      expect(ranNpmTest).toBe(true);
      if (withContextMode) {
        expect([...toolNames].some((name) => name.startsWith("ctx_"))).toBe(true);
      }
      runs.push({
        label,
        workspacePath,
        usage,
        elapsedMs,
        modelRoutes: [...modelRoutes],
        toolNames: [...toolNames],
        ranNpmTest,
        toolResultChars,
        files,
      });
    } finally {
      await harness.close();
    }
  }

  console.log(
    JSON.stringify(
      {
        runtime: "installed Pi GUI; Qwen Token Plan Max only; isolated profiles",
        task: "same disposable Pi GUI Studio demo fix and npm test",
        runs,
      },
      null,
      2,
    ),
  );
});
