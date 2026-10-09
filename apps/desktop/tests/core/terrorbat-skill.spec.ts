import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import {
  commitAllInGitRepo,
  createNamedThread,
  launchDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  seedAgentDir,
} from "../helpers/electron-app";
import {
  messageText,
  pickShellTool,
  scriptedText,
  scriptedToolCall,
  startScriptedOpenAiServer,
  toolExchanges,
  userText,
  type ScriptedActor,
} from "../helpers/scripted-openai-provider";

const execFileAsync = promisify(execFile);
const SKILL_SOURCE = join(__dirname, "../../../../.agents/skills/terrorbat/SKILL.md");
const REQUEST =
  "Use Terror Bat to challenge the claim that writing a file leaves the worktree unchanged.";
const POSITIVE = `version: terrorbat/v1
id: skill-positive
claim:
  text: Writing a file leaves the worktree unmodified.
requires: [fs.write, fs.read, git.inspect]
attack:
  setup:
    - adapter: fs
      action: digest
      path: .
  run:
    - adapter: fs
      action: write
      path: tb-skill-probe.txt
      text: probe
oracle:
  type: path_changed
  path: tb-skill-probe.txt
evidence:
  capture: [git_diff, stdout, stderr]
timeout:
  run: 60s
  total: 120s
`;
const CONTROL = `version: terrorbat/v1
id: skill-control
claim:
  text: An untouched probe path shows no change.
requires: [fs.read, git.inspect]
attack:
  run:
    - adapter: fs
      action: digest
      path: .
oracle:
  type: path_changed
  path: tb-never-written.txt
evidence:
  capture: [git_diff, stdout, stderr]
timeout:
  run: 60s
  total: 120s
`;

async function workspaceWithSkill(name: string) {
  const repo = await makeGitWorkspace(name);
  const skillDir = join(repo, ".agents", "skills", "terrorbat");
  await mkdir(skillDir, { recursive: true });
  await cp(SKILL_SOURCE, join(skillDir, "SKILL.md"));
  await commitAllInGitRepo(repo, "add Terror Bat skill");
  return repo;
}

async function configure(agentDir: string, baseUrl: string, modelId: string) {
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: [`terrorbat-fixture/${modelId}`],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "terrorbat-fixture",
      defaultModel: modelId,
      enabledModels: [`terrorbat-fixture/${modelId}`],
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "terrorbat-fixture": {
          baseUrl,
          api: "openai-completions",
          apiKey: "unused",
          models: [{ id: modelId }],
        },
      },
    }),
  );
}

async function loadReceipts(store: string) {
  const runIds = await readdir(join(store, "runs"));
  return Promise.all(
    runIds.map(
      async (id) =>
        JSON.parse(await readFile(join(store, "runs", id, "receipt.json"), "utf8")) as Record<
          string,
          unknown
        >,
    ),
  );
}

test("Terror Bat appears in native Skills UI and slash menu after restart", async () => {
  test.setTimeout(90_000);
  const profile = await makeUserDataDir("pi-gui-terrorbat-ui-");
  const agentDir = join(profile, "agent");
  const repo = await workspaceWithSkill("terrorbat-skill-ui");
  let app = await launchDesktop(profile, {
    agentDir,
    initialWorkspaces: [repo],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    let window = await app.firstWindow();
    await createNamedThread(window, "Terror Bat UI");
    await window.getByRole("button", { name: "Skills", exact: true }).click();
    const list = window.getByTestId("skills-list");
    const row = list.getByRole("button", { name: /Terror Bat/i });
    await expect(row).toBeVisible();
    const toggle = list.getByRole("switch", { name: "Enable Terrorbat" });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await app.close();

    app = await launchDesktop(profile, {
      agentDir,
      initialWorkspaces: [repo],
      scrubProviderEnv: true,
      testMode: "background",
    });
    window = await app.firstWindow();
    await createNamedThread(window, "Terror Bat after restart");
    await window.getByRole("button", { name: "Skills", exact: true }).click();
    const restartedList = window.getByTestId("skills-list");
    const restarted = restartedList.getByRole("button", { name: /Terror Bat/i });
    const restartedToggle = restartedList.getByRole("switch", { name: "Enable Terrorbat" });
    await expect(restarted).toBeVisible();
    await expect(restartedToggle).not.toBeChecked();
    await restartedToggle.click();
    await restarted.click();
    await expect(window.locator(".skill-detail")).toContainText("adversarial, recovery");
    await window.getByRole("button", { name: "Try", exact: true }).click();
    const composer = window.getByTestId("composer");
    await expect(composer).toHaveValue("/skill:terrorbat ");
    await composer.fill("/skill:terror");
    await expect(window.getByTestId("slash-menu")).toContainText("/skill:terrorbat");
  } finally {
    await app.close();
  }
});

test("relevant natural-language request discovers skill and runs Terror Bat CLI", async () => {
  test.setTimeout(150_000);
  const exe = process.platform === "win32" ? "terrorbat.exe" : "terrorbat";
  let version = "";
  try {
    version = (await execFileAsync(exe, ["--version"])).stdout.trim();
  } catch {
    test.skip(true, "This execution proof requires the installed Terror Bat CLI.");
  }

  const profile = await makeUserDataDir("pi-gui-terrorbat-cli-");
  const agentDir = join(profile, "agent");
  const repo = await workspaceWithSkill("terrorbat-skill-cli");
  const positivePath = join(profile, "positive.yaml");
  const controlPath = join(profile, "control.yaml");
  const invalidPath = join(profile, "invalid.yaml");
  const store = join(profile, "evidence");
  await writeFile(positivePath, POSITIVE);
  await writeFile(controlPath, CONTROL);
  await writeFile(invalidPath, "version: terrorbat/v999\nattack: []\n");

  let advertised = false;
  const actor: ScriptedActor = {
    name: "terrorbat-skill",
    matches: () => true,
    respond: (context) => {
      if (!userText(context).includes(REQUEST)) return scriptedText("Ordinary task done.");
      const system = context.messages
        .filter((m) => m.role === "system")
        .map(messageText)
        .join("\n");
      advertised ||= system.includes("Use Terror Bat for adversarial, recovery");
      const calls = toolExchanges(context);
      const read = calls.find((call) => call.name === "read");
      if (!read) return scriptedToolCall("read", { path: ".agents/skills/terrorbat/SKILL.md" });
      if (!read.resultText.includes("not a security sandbox")) {
        return scriptedText("FAIL: skill body was not loaded");
      }
      const shell = pickShellTool(context.toolNames);
      const shellCalls = calls.filter((call) => call.name === shell);
      const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const check = shellCalls.find((call) => String(call.args.command).includes("spec check"));
      if (!check) {
        return scriptedToolCall(shell, {
          command: `terrorbat spec check ${quote(positivePath)}`,
        });
      }
      if (!/\b(ok|valid)\b/i.test(check.resultText)) {
        return scriptedText(`FAIL: invalid spec: ${check.resultText}`);
      }
      if (!shellCalls.some((call) => String(call.args.command).includes("terrorbat run"))) {
        return scriptedToolCall(shell, {
          command: `terrorbat run ${quote(positivePath)} --repo ${quote(repo)} --store ${quote(store)} --json`,
        });
      }
      return scriptedText("Terror Bat executed; inspect its durable receipt.");
    },
  };
  const server = await startScriptedOpenAiServer([actor]);
  await configure(agentDir, server.baseUrl, server.modelId);
  const app = await launchDesktop(profile, {
    agentDir,
    initialWorkspaces: [repo],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const window = await app.firstWindow();
    await createNamedThread(window, "Terror Bat automatic selection");
    const composer = window.getByTestId("composer");
    await composer.fill("Summarize this repository.");
    await window.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(
      window.locator(".timeline-item--assistant .message__content").last(),
    ).toContainText("Ordinary task done", { timeout: 30_000 });
    expect(
      server
        .requestLog()
        .flatMap((entry) => toolExchanges(entry))
        .filter((call) => ["read", "bash", "powershell"].includes(call.name)),
    ).toHaveLength(0);

    await composer.fill(REQUEST);
    await window.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(
      window.locator(".timeline-item--assistant .message__content").last(),
    ).toContainText("Terror Bat executed", { timeout: 60_000 });
    expect(advertised).toBe(true);
    const exchanges = server.requestLog().flatMap((entry) => toolExchanges(entry));
    expect(exchanges.some((call) => call.name === "read")).toBe(true);
    expect(exchanges.some((call) => String(call.args.command).includes("spec check"))).toBe(true);
    expect(exchanges.some((call) => String(call.args.command).includes("terrorbat run"))).toBe(
      true,
    );

    const [finding] = await loadReceipts(store);
    expect(finding).toMatchObject({
      verdict: "PROVEN",
      oracle: { result: "Falsified" },
      execution: { status: "Completed" },
    });
    const receiptId = String(finding?.receipt_id);
    expect(
      (await execFileAsync(exe, ["inspect", receiptId, "--store", store, "--json"])).stdout,
    ).toContain("PROVEN");

    const controlStore = join(profile, "control-store");
    await execFileAsync(exe, [
      "run",
      controlPath,
      "--repo",
      repo,
      "--store",
      controlStore,
      "--json",
    ]);
    const [control] = await loadReceipts(controlStore);
    expect(control).toMatchObject({
      verdict: "NOT OBSERVED",
      oracle: { result: "NotFalsified" },
      execution: { status: "Completed" },
    });

    const invalid = await execFileAsync(exe, ["spec", "check", invalidPath]).then(
      () => "",
      (error: unknown) => String(error),
    );
    expect(invalid).toMatch(/invalid|error|unsupported/i);
    await expect(readFile(invalidPath, "utf8")).resolves.toContain("terrorbat/v999");
    const dirtyPath = join(repo, "preserve-me.txt");
    await writeFile(dirtyPath, "leave local work alone");
    const dirty = await execFileAsync(exe, [
      "run",
      positivePath,
      "--repo",
      repo,
      "--store",
      join(profile, "dirty-store"),
      "--json",
    ]).then(
      () => "",
      (error: unknown) => String(error),
    );
    expect(dirty).toMatch(/clean|dirty/i);
    await expect(readFile(dirtyPath, "utf8")).resolves.toBe("leave local work alone");
    expect(version).toMatch(/^terrorbat /);
  } finally {
    await app.close();
    await server.close();
  }
});
