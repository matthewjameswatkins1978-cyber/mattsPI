import { expect, test } from "@playwright/test";
import {
  assertStudioCompletionWithReconciliation,
  isWaitableStudioEvidenceGap,
  resolveStudioEvidenceWaitMs,
} from "../../electron/studio/studio-gate-reconciliation";

function fakeClock() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      time += ms;
    },
  };
}

test("passes straight through when the gate accepts on the first check", async () => {
  const clock = fakeClock();
  let checks = 0;
  const result = await assertStudioCompletionWithReconciliation(
    () => {
      checks += 1;
    },
    { waitMs: 90_000, pollMs: 250, ...clock },
  );
  expect(checks).toBe(1);
  expect(result.waits).toBe(0);
  expect(clock.sleeps).toEqual([]);
});

test("waits inside the host while transcript-derived evidence is in flight", async () => {
  const clock = fakeClock();
  let checks = 0;
  const result = await assertStudioCompletionWithReconciliation(
    () => {
      checks += 1;
      if (checks <= 3) {
        throw new Error(
          "The Studio coordinator must read the independent-inspector thread before accepting m1.",
        );
      }
    },
    { waitMs: 90_000, pollMs: 250, ...clock },
  );
  expect(result.waits).toBe(3);
  expect(clock.sleeps).toEqual([250, 250, 250]);
});

test("structural gaps reject immediately without burning the wait budget", async () => {
  const clock = fakeClock();
  let checks = 0;
  await expect(
    assertStudioCompletionWithReconciliation(
      () => {
        checks += 1;
        throw new Error(
          "Milestone m1 needs a linked independent-inspector child from this coordinator.",
        );
      },
      { waitMs: 90_000, pollMs: 250, ...clock },
    ),
  ).rejects.toThrow("needs a linked independent-inspector child");
  expect(checks).toBe(1);
  expect(clock.sleeps).toEqual([]);
});

test("a missing coordinator binding is structural and never waits", () => {
  expect(
    isWaitableStudioEvidenceGap(
      new Error("A milestone cannot pass verification without its coordinator thread."),
    ),
  ).toBe(false);
});

test("every transcript-derived gate clause is waitable", () => {
  for (const message of [
    "Milestone m1 verifier thread has not completed.",
    "Milestone m1 verifier has no successful specification-relevant check evidence.",
    "Milestone m1 verifier has no successful Git diff/status inspection evidence.",
    "Milestone m1 inspector must finish with an explicit PASS verdict.",
    "The Studio coordinator must read the independent-inspector thread before accepting m1.",
  ]) {
    expect(isWaitableStudioEvidenceGap(new Error(message)), message).toBe(true);
  }
});

test("the wait is bounded and rethrows the last gate error unchanged", async () => {
  const clock = fakeClock();
  await expect(
    assertStudioCompletionWithReconciliation(
      () => {
        throw new Error("Milestone m1 verifier thread has not completed.");
      },
      { waitMs: 1_000, pollMs: 250, ...clock },
    ),
  ).rejects.toThrow("verifier thread has not completed");
  expect(clock.sleeps.length).toBe(4);
});

test("a gap that turns structural while waiting fails fast", async () => {
  const clock = fakeClock();
  let checks = 0;
  await expect(
    assertStudioCompletionWithReconciliation(
      () => {
        checks += 1;
        if (checks === 1) {
          throw new Error("Milestone m1 verifier thread has not completed.");
        }
        throw new Error("A milestone cannot pass verification without its coordinator thread.");
      },
      { waitMs: 90_000, pollMs: 250, ...clock },
    ),
  ).rejects.toThrow("without its coordinator thread");
  expect(checks).toBe(2);
});

test("waitMs=0 disables host waiting entirely", async () => {
  const clock = fakeClock();
  await expect(
    assertStudioCompletionWithReconciliation(
      () => {
        throw new Error("Milestone m1 verifier thread has not completed.");
      },
      { waitMs: 0, ...clock },
    ),
  ).rejects.toThrow("verifier thread has not completed");
  expect(clock.sleeps).toEqual([]);
});

test("resolveStudioEvidenceWaitMs parses, clamps and defaults safely", () => {
  expect(resolveStudioEvidenceWaitMs(undefined)).toBe(90_000);
  expect(resolveStudioEvidenceWaitMs("  ")).toBe(90_000);
  expect(resolveStudioEvidenceWaitMs("not-a-number")).toBe(90_000);
  expect(resolveStudioEvidenceWaitMs("0")).toBe(0);
  expect(resolveStudioEvidenceWaitMs("-5")).toBe(0);
  expect(resolveStudioEvidenceWaitMs("1500")).toBe(1_500);
  expect(resolveStudioEvidenceWaitMs("999999999")).toBe(600_000);
});
