import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import studioExtension, { parseRoleAssignments, supportedThinkingLevels } from "../index.ts";

await test("version 1 route preferences remain readable with model-default thinking", () => {
  const preferences = parseRoleAssignments({
    version: 1,
    roles: { IMPLEMENTER: "qwen-token-plan/qwen3.8-max" },
  });

  assert.deepEqual(preferences.IMPLEMENTER, {
    model: "qwen-token-plan/qwen3.8-max",
    thinkingLevel: "default",
  });
  assert.equal(preferences.COORDINATOR?.thinkingLevel, "default");
});

await test("version 2 supports model default and rejects forbidden levels", () => {
  const preferences = parseRoleAssignments({
    version: 2,
    roles: {
      IMPLEMENTER: { model: "qwen-token-plan/qwen3.8-max", thinkingLevel: "high" },
      RESEARCHER: { model: "qwen-token-plan/qwen3.8-flash", thinkingLevel: "xhigh" },
      COORDINATOR: { model: "qwen-token-plan/qwen3.8-max", thinkingLevel: "default" },
    },
  });

  assert.equal(preferences.IMPLEMENTER?.thinkingLevel, "high");
  assert.equal(preferences.RESEARCHER?.thinkingLevel, "default");
  assert.equal(preferences.COORDINATOR?.thinkingLevel, "default");
});

await test("thinking choices honor Pi model capability and omit xhigh/max", () => {
  assert.deepEqual(
    supportedThinkingLevels({
      reasoning: true,
      thinkingLevelMap: {
        off: "none",
        minimal: null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
    }),
    ["off", "low", "medium", "high"],
  );
  assert.deepEqual(
    supportedThinkingLevels({ reasoning: false, thinkingLevelMap: { off: "none" } }),
    ["off"],
  );
});

await test("the models command saves model and thinking for future tasks, not the current session", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-studio-preferences-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const preferencePath = join(agentDir, "studio-models.json");
  await writeFile(
    preferencePath,
    JSON.stringify({
      version: 1,
      roles: { IMPLEMENTER: "qwen-token-plan/qwen3.8-max" },
    }),
  );

  try {
    let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
    const sentMessages: string[] = [];
    const notifications: string[] = [];
    const prompts: { title: string; options?: string[] }[] = [];
    const selections = ["IMPLEMENTER", "Qwen Max — qwen-token-plan/qwen3.8-max", "high"];
    const model = {
      id: "qwen3.8-max",
      name: "Qwen Max",
      provider: "qwen-token-plan",
      reasoning: true,
      thinkingLevelMap: { off: "off", low: "low", medium: "medium", high: "high", max: "max" },
    };
    const pi = {
      registerCommand: (_name: string, options: typeof command) => {
        command = options;
      },
      sendUserMessage: (message: string) => sentMessages.push(message),
    };
    studioExtension(pi as never);
    assert.ok(command);

    const ctx = {
      scopedModels: [],
      modelRegistry: {
        getAvailable: () => [model],
        hasConfiguredAuth: () => true,
        find: () => model,
      },
      ui: {
        select: async (title: string, options: string[]) => {
          prompts.push({ title, options });
          return selections.shift();
        },
        confirm: async () => true,
        notify: (message: string) => notifications.push(message),
      },
    };

    await command.handler("models", ctx);
    const saved = JSON.parse(await readFile(preferencePath, "utf8"));
    assert.equal(saved.version, 2);
    assert.deepEqual(saved.roles.IMPLEMENTER, {
      model: "qwen-token-plan/qwen3.8-max",
      thinkingLevel: "high",
    });
    assert.ok(prompts[2]?.options?.includes("high"));
    assert.ok(!prompts[2]?.options?.includes("xhigh"));
    assert.ok(!prompts[2]?.options?.includes("max"));
    assert.match(notifications[0] ?? "", /Saved IMPLEMENTER/);

    await command.handler("", ctx);
    assert.match(
      sentMessages.at(-1) ?? "",
      /IMPLEMENTER: qwen-token-plan\/qwen3\.8-max; thinking high; host route VERIFIED/,
    );

    const unavailableCtx = {
      ...ctx,
      scopedModels: [],
      modelRegistry: {
        getAvailable: () => [],
        hasConfiguredAuth: () => false,
        find: () => undefined,
      },
    };
    await command.handler("start", unavailableCtx);
    assert.match(
      sentMessages.at(-1) ?? "",
      /INDEPENDENT_INSPECTOR: .*host route UNAVAILABLE/,
    );
    assert.match(
      sentMessages.at(-1) ?? "",
      /mark verification blocked and do not dispatch a substitute or use metered fallback/i,
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});
