/**
 * Host-side reconciliation for the Studio verification gate.
 *
 * The gate's evidence is derived from live session transcripts. When another
 * child session is streaming concurrently, the event that finalises the
 * coordinator's `read_thread` tool result can sit behind that backlog for tens
 * of seconds, so a completion save would otherwise be rejected even though the
 * runtime already produced the evidence. Coordinators previously had to burn
 * inference turns re-saving until the projection caught up.
 *
 * This module keeps every verification requirement intact — evidence is never
 * accepted as missing — but lets the host wait a bounded time for the
 * derivation pipeline to catch up before returning a rejection.
 */

const DEFAULT_STUDIO_EVIDENCE_WAIT_MS = 90_000;
const MAX_STUDIO_EVIDENCE_WAIT_MS = 600_000;
const DEFAULT_STUDIO_EVIDENCE_POLL_MS = 250;

/**
 * Gate failures whose evidence arrives through transcript projection and can
 * therefore be in flight while the save is being evaluated. Structural failures
 * (missing coordinator binding, inspector never dispatched) are deliberately
 * absent: waiting cannot conjure them, so they must reject immediately.
 */
const WAITABLE_STUDIO_EVIDENCE_GAPS: readonly RegExp[] = [
  /verifier thread has not completed/i,
  /no successful specification-relevant check evidence/i,
  /no successful Git diff\/status inspection evidence/i,
  /must finish with an explicit PASS verdict/i,
  /must read the independent-inspector thread/i,
];

export function isWaitableStudioEvidenceGap(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return WAITABLE_STUDIO_EVIDENCE_GAPS.some((pattern) => pattern.test(message));
}

export function resolveStudioEvidenceWaitMs(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_STUDIO_EVIDENCE_WAIT_MS;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return DEFAULT_STUDIO_EVIDENCE_WAIT_MS;
  if (parsed <= 0) return 0;
  return Math.min(Math.round(parsed), MAX_STUDIO_EVIDENCE_WAIT_MS);
}

export interface StudioEvidenceReconciliationOptions {
  /** Total host-side wait budget in milliseconds; 0 disables waiting. */
  waitMs: number;
  /** Delay between re-projections while waiting. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface StudioEvidenceReconciliationResult {
  /** How many bounded re-projection waits the host performed (0 = first check passed or failed structurally). */
  waits: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `recheck` (which re-projects child evidence and asserts the gate,
 * throwing on failure). Waitable evidence gaps are retried inside the host
 * until `waitMs` elapses; the final gate error is rethrown unchanged so
 * rejection semantics never weaken. Non-waitable errors rethrow immediately.
 */
export async function assertStudioCompletionWithReconciliation(
  recheck: () => void,
  options: StudioEvidenceReconciliationOptions,
): Promise<StudioEvidenceReconciliationResult> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const pollMs = Math.max(1, options.pollMs ?? DEFAULT_STUDIO_EVIDENCE_POLL_MS);
  let waits = 0;
  try {
    recheck();
    return { waits };
  } catch (error) {
    if (options.waitMs <= 0 || !isWaitableStudioEvidenceGap(error)) throw error;
  }
  const deadline = now() + options.waitMs;
  let lastError: unknown;
  while (now() < deadline) {
    await sleep(pollMs);
    waits += 1;
    try {
      recheck();
      return { waits };
    } catch (error) {
      if (!isWaitableStudioEvidenceGap(error)) throw error;
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Studio milestone completion failed independent verification.");
}
