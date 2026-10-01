import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  commitAllInGitRepo,
  getDesktopState,
  launchDesktop,
  makeGitWorkspace,
  makeUserDataDir,
  startThreadViaIpc,
  writeTextFile,
} from "../helpers/electron-app";

const execFileAsync = promisify(execFile);

/**
 * One small real-model Studio coding job (Pilot 1, item 5).
 *
 * A real subscription-route model (Qwen Token Plan, medium reasoning) acts as
 * the Studio coordinator for a single-milestone repair on a disposable math
 * repository. Every orchestration step runs natively: host-owned evidence
 * reconciliation, compact read receipts, worktree isolation, the independent
 * verification gate, local-only delivery, and combined usage accounting.
 *
 * Strict budget: one hard test timeout, no retries, and the profile enables
 * exactly one model route so no metered fallback exists. If the budget is
 * exhausted the run fails with diagnostics and stops; it never continues
 * silently. Requires PI_APP_REAL_AUTH=1 and PI_APP_REAL_AUTH_SOURCE_DIR.
 */

const PROVIDER = "qwen-token-plan";
const MODEL_ID = "qwen3.8-max";
const THINKING_LEVEL = "medium";

const SPECIFICATION = [
  "Repair the addition bug in src/math.mjs so add(left, right) returns the sum",
  "and the repository test command `node --test` passes.",
  "Plan exactly one milestone for this repair.",
  "Strict budget: one IMPLEMENTER child in a worktree and one INDEPENDENT_INSPECTOR child,",
  "no other children, no exploratory work beyond the bug.",
  "Save run state only when a milestone status actually changes.",
  "After the verification gate passes, merge the worker branch into main locally",
  "and mark the run completed.",
].join(" ");

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

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd });
  return stdout.trim();
}

function requireRealAuthSource(): string {
  const source = process.env.PI_APP_REAL_AUTH_SOURCE_DIR?.trim();
  if (process.env.PI_APP_REAL_AUTH !== "1" || !source || !isAbsolute(source)) {
    throw new Error(
      "This real-model job requires PI_APP_REAL_AUTH=1 and an absolute PI_APP_REAL_AUTH_SOURCE_DIR agent directory.",
    );
  }
  return source;
}

test("Studio completes one small real-model coding job on the subscription route", async () => {
  test.setTimeout(1_500_000);
  const realAuthSourceDir = requireRealAuthSource();
  const jobStartedAt = Date.now();
  const proofDir = process.env.PI_APP_STUDIO_REAL_JOB_PROOF_DIR?.trim();
  if (proofDir) {
    await mkdir(proofDir, { recursive: true });
  }

  const workspacePath = await makeGitWorkspace("studio-real-model-job");
  await writeTextFile(
    join(workspacePath, "package.json"),
    `${JSON.stringify(
      { name: "studio-real-job-math", private: true, type: "module", version: "1.0.0" },
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

  const userDataDir = await makeUserDataDir("pi-gui-studio-real-job-");
  const harness = await launchDesktop(userDataDir, {
    realAuthSourceDir,
    // Exactly one enabled route: no metered fallback exists in this profile.
    enabledModels: [`${PROVIDER}/${MODEL_ID}`],
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();

    // 1. Real coordinator thread pinned to the subscription route with medium
    //    reasoning. The priming prompt is one cheap turn that proves the route
    //    works before any orchestration budget is spent.
    await startThreadViaIpc(window, {
      provider: PROVIDER,
      modelId: MODEL_ID,
      thinkingLevel: THINKING_LEVEL,
      prompt: "Reply with exactly: READY. Do not call any tools.",
    });
    const coordinatorSessionId = (await getDesktopState(window)).selectedSessionId;
    expect(coordinatorSessionId).toBeTruthy();
    await expect
      .poll(
        async () => {
          const state = await getDesktopState(window);
          const session = state.workspaces
            .flatMap((workspace) => workspace.sessions)
            .find((entry) => entry.id === coordinatorSessionId);
          return session?.status ?? "missing";
        },
        { timeout: 120_000 },
      )
      .toBe("idle");
    const primedState = await getDesktopState(window);
    const coordinatorRecord = primedState.workspaces
      .flatMap((workspace) => workspace.sessions)
      .find((entry) => entry.id === coordinatorSessionId);
    expect(coordinatorRecord?.config).toMatchObject({
      provider: PROVIDER,
      modelId: MODEL_ID,
      thinkingLevel: THINKING_LEVEL,
    });

    // 2. Record the single-milestone plan through the authorised UI path with
    //    the local-only delivery policy.
    await window.getByTestId("sidebar-studio").click();
    await expect(window.getByTestId("studio-runs-view")).toBeVisible();
    await window.getByLabel("Delivery").selectOption("local");
    await window.getByLabel("Specification or implementation packet").fill(SPECIFICATION);
    await window.getByRole("button", { name: "Prepare in current thread" }).click();
    await window.getByTestId("sidebar-studio").click();
    await expect
      .poll(async () => (await getDesktopState(window)).studioRuns[0]?.status, {
        timeout: 60_000,
      })
      .toBe("draft");
    const draftRun = (await getDesktopState(window)).studioRuns[0]!;
    expect(draftRun).toMatchObject({
      deliveryPolicy: "local",
      coordinatorSessionId,
      milestones: [expect.objectContaining({ deliveryRequirement: "local" })],
    });

    // 3. Start: the real model coordinates from here through native tools.
    await window.getByRole("button", { name: "Start in prepared thread" }).click();

    // 4. The run must reach completed through the host verification gate,
    //    inside the strict budget.
    try {
      await expect
        .poll(
          async () => {
            const state = await getDesktopState(window);
            const run = state.studioRuns[0];
            if (!run) return "missing";
            if (run.status === "completed") return "completed";
            return `${run.status}[${run.milestones
              .map((milestone) => `${milestone.id}:${milestone.status}`)
              .join(",")}]`;
          },
          { timeout: 1_200_000, intervals: [5_000] },
        )
        .toBe("completed");
    } catch (error) {
      const stalledState = await getDesktopState(window);
      const diagnostics = {
        budgetExhaustedOrStalled: true,
        elapsedMs: Date.now() - jobStartedAt,
        studioRun: stalledState.studioRuns[0],
        children: stalledState.orchestrationChildren.map((child) => ({
          taskId: child.taskId,
          role: child.role,
          status: child.status,
          branchName: child.branchName,
          worktreePath: child.worktreePath,
          latestTranscript: child.latestTranscript?.slice(0, 600),
          evidence: child.evidence.slice(0, 10).map((record) => ({
            title: record.title,
            status: record.status,
            command: record.command,
          })),
        })),
        sessionUsage: stalledState.sessionUsageBySession,
      };
      const diagnosticsPath = join(userDataDir, "real-job-stall-diagnostics.json");
      await writeFile(diagnosticsPath, `${JSON.stringify(diagnostics, null, 2)}\n`);
      console.log(`Real-model Studio job stalled; diagnostics at ${diagnosticsPath}`);
      console.log(JSON.stringify(diagnostics, null, 2).slice(0, 20_000));
      throw error;
    }

    const elapsedMs = Date.now() - jobStartedAt;

    // 5. Route integrity: every session stayed on the subscription route with
    //    no fallback anywhere.
    const finalStatePre = await getDesktopState(window);
    const run = finalStatePre.studioRuns[0]!;
    expect(run.coordinatorSessionId).toBe(coordinatorSessionId);
    expect(run.deliveryPolicy).toBe("local");
    const childSessionIds = finalStatePre.orchestrationChildren
      .map((child) => child.childSessionId)
      .filter((id): id is string => Boolean(id));
    for (const session of finalStatePre.workspaces.flatMap((workspace) => workspace.sessions)) {
      if (session.config?.provider) {
        expect(
          session.config.provider,
          `session ${session.id} stayed on the subscription route`,
        ).toBe(PROVIDER);
      }
    }
    for (const child of finalStatePre.orchestrationChildren) {
      if (child.model) {
        expect(child.model.provider, `child ${child.taskId} stayed on the subscription route`).toBe(
          PROVIDER,
        );
      }
    }

    // 6. Verified completion: exactly the budgeted children, full gate
    //    evidence, and a locally merged, passing repository.
    const activeMilestones = run.milestones.filter((milestone) => milestone.status !== "cancelled");
    expect(activeMilestones.length).toBeGreaterThanOrEqual(1);
    for (const milestone of activeMilestones) {
      expect(milestone.status, `${milestone.id} status`).toBe("complete");
      expect(milestone.deliveryRequirement).toBe("local");
      expect(milestone.workerThreadIds.length).toBeGreaterThanOrEqual(2);
    }
    const children = finalStatePre.orchestrationChildren;
    const implementers = children.filter((child) => child.role === "IMPLEMENTER");
    const inspectors = children.filter((child) => child.role === "INDEPENDENT_INSPECTOR");
    // Budget: one of each; a second is tolerated only via the documented
    // bounded-repair path (a FAIL verdict permits at most two repair attempts).
    expect(implementers.length, "budget: at most two implementers").toBeLessThanOrEqual(2);
    expect(inspectors.length, "budget: at most two inspectors").toBeLessThanOrEqual(2);
    expect(implementers.length).toBeGreaterThanOrEqual(1);
    expect(inspectors.length).toBeGreaterThanOrEqual(1);
    for (const child of [...implementers, ...inspectors]) {
      expect(child.status, `${child.taskId} status`).toBe("complete");
    }
    expect(implementers[0]!.environment).toBe("worktree");
    expect(implementers[0]!.branchName).toBeTruthy();
    expect(inspectors[0]!.environment).toBe("local");
    const inspector = inspectors.find((child) =>
      child.evidence.some(
        (record) =>
          record.kind === "orchestrator_observation" &&
          record.title === "Orchestrator read child output",
      ),
    );
    expect(inspector, "an inspector the coordinator actually read").toBeDefined();
    const inspectorEvidence = inspector!.evidence;
    expect(
      inspectorEvidence.some(
        (record) =>
          record.kind === "command" &&
          record.status === "passed" &&
          record.title === "Test command run",
      ),
      "inspector ran the real test command",
    ).toBe(true);
    expect(
      inspectorEvidence.some(
        (record) =>
          record.kind === "command" &&
          record.status === "passed" &&
          record.command &&
          /\bgit\s+(diff|show|status)\b/i.test(record.command),
      ),
      "inspector inspected the real repository diff",
    ).toBe(true);
    expect(
      inspectorEvidence.some(
        (record) =>
          record.kind === "orchestrator_observation" &&
          record.title === "Orchestrator read child output",
      ),
      "coordinator read the inspector output",
    ).toBe(true);
    const inspectorVerdict = [...(inspector!.transcript ?? [])]
      .reverse()
      .find((message) => message.role === "child");
    expect(inspectorVerdict?.text.trim().startsWith("PASS")).toBe(true);

    await expect(
      execFileAsync("node", ["--test"], { cwd: workspacePath }).then(
        () => "passed",
        () => "failed",
      ),
    ).resolves.toBe("passed");
    const fixedSource = await readFile(join(workspacePath, "src", "math.mjs"), "utf8");
    expect(fixedSource).toContain("left + right");
    const mainLog = await gitOutput(workspacePath, ["log", "--oneline", "main"]);
    expect(mainLog.split("\n")[0]!).not.toBe(baselineSha.slice(0, 7));
    expect(await gitOutput(workspacePath, ["branch", "--contains", baselineSha])).toContain("main");

    // 7. The host persisted the verified ledger.
    const ledgerFile = JSON.parse(
      await readFile(join(userDataDir, "studio-runs.json"), "utf8"),
    ) as { runs: Record<string, unknown>[] };
    const persistedRun = ledgerFile.runs.find(
      (entry) => (entry as { id?: string }).id === run.id,
    ) as Record<string, unknown> | undefined;
    expect(persistedRun).toMatchObject({ status: "completed", deliveryPolicy: "local" });

    // 8. Combined accounting: select the coordinator thread and count its real
    //    turns and tool calls; usage totals come from Pi's own accounting.
    await window.locator(`.session-row[data-session-id="${coordinatorSessionId}"]`).first().click();
    await expect
      .poll(async () => (await getDesktopState(window)).selectedSessionId, { timeout: 30_000 })
      .toBe(coordinatorSessionId);
    const finalState = await getDesktopState(window);
    const selectedTranscript = await window.evaluate(async () => {
      const app = globalThis.window.piApp;
      if (!app) {
        throw new Error("piApp IPC bridge is unavailable");
      }
      return app.getSelectedTranscript();
    });
    expect(selectedTranscript?.sessionId).toBe(coordinatorSessionId);
    const coordinatorTranscript = selectedTranscript?.transcript ?? [];
    const coordinatorTurns = coordinatorTranscript.filter(
      (message) => message.kind === "message" && message.role === "assistant",
    ).length;
    const coordinatorToolCalls = coordinatorTranscript.reduce<Record<string, number>>(
      (counts, message) => {
        if (message.kind !== "tool") return counts;
        counts[message.toolName] = (counts[message.toolName] ?? 0) + 1;
        return counts;
      },
      {},
    );
    const rejectedSaves = coordinatorTranscript.filter(
      (message) =>
        message.kind === "tool" &&
        message.toolName === "save_studio_run" &&
        message.status === "error",
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
    expect(
      combinedUsage.input + combinedUsage.output,
      "real token totals must be recorded",
    ).toBeGreaterThan(0);
    const childTurns = children.reduce(
      (total, child) =>
        total + (child.transcript ?? []).filter((message) => message.role === "child").length,
      0,
    );

    const costReport = {
      job: "studio-single-milestone-real-model",
      route: { provider: PROVIDER, modelId: MODEL_ID, thinkingLevel: THINKING_LEVEL },
      runId: run.id,
      finalRevision: run.revision,
      elapsedMs,
      modelTurns: {
        coordinator: coordinatorTurns,
        childrenProjected: childTurns,
        note: "child counts derive from projected transcripts (bounded to the last 40 messages)",
      },
      toolCalls: { coordinatorByTool: coordinatorToolCalls },
      saves: {
        rejected: rejectedSaves,
        note: "host-side reconciliation absorbs evidence lag; rejections here are real gate decisions",
      },
      tokenUsage: {
        sessions: usageEntries.length,
        combinedTotals: combinedUsage,
        bySession: finalState.sessionUsageBySession,
      },
      children: children.map((child) => ({
        taskId: child.taskId,
        role: child.role,
        status: child.status,
        branchName: child.branchName,
        worktreePath: child.worktreePath,
      })),
    };
    console.log(
      `Real-model Studio job: elapsedMs=${elapsedMs} coordinatorTurns=${coordinatorTurns} ` +
        `toolCalls=${Object.values(coordinatorToolCalls).reduce((a, b) => a + b, 0)} ` +
        `rejectedSaves=${rejectedSaves} tokens(in/out/cacheR/cacheW)=` +
        `${combinedUsage.input}/${combinedUsage.output}/${combinedUsage.cacheRead}/${combinedUsage.cacheWrite}`,
    );

    if (proofDir) {
      await window.getByTestId("sidebar-studio").click();
      await expect(window.getByTestId("studio-runs-view")).toBeVisible();
      await window.screenshot({
        path: join(proofDir, "studio-real-model-job-final.png"),
        fullPage: true,
      });
      await writeFile(
        join(proofDir, "cost-report.json"),
        `${JSON.stringify(costReport, null, 2)}\n`,
      );
      await writeFile(
        join(proofDir, "studio-runs.json"),
        `${JSON.stringify(ledgerFile, null, 2)}\n`,
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
            childSessionIds,
            children: costReport.children,
          },
          null,
          2,
        )}\n`,
      );
      console.log(`Real-model Studio job artifacts: ${proofDir}`);
    }
    console.log(
      `Real-model Studio run ${run.id} completed at revision ${run.revision}; repository preserved at ${workspacePath}`,
    );
  } finally {
    await harness.close();
  }
});
