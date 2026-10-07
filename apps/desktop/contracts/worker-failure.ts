export type WorkerFailureClass = "infrastructure" | "task";

export interface WorkerFailureInput {
  readonly message: string;
  readonly code?: string;
}

/** Recognise only strong provider availability signals; ambiguous errors stay task failures. */
export function classifyWorkerFailure(error: WorkerFailureInput): WorkerFailureClass {
  const message = error.message.toLowerCase();
  const code = error.code?.toLowerCase() ?? "";
  if (
    /(?:^|\D)(?:401|403)(?:\D|$)/.test(`${code} ${message}`) ||
    /unauthori[sz]ed|invalid api key|authentication credentials are invalid/.test(message)
  ) {
    return "infrastructure";
  }
  if (
    /(?:^|\D)429(?:\D|$)/.test(`${code} ${message}`) ||
    /quota\s+(?:is\s+)?(?:exhausted|exceeded)|rate.?limit(?:ed)?/.test(message)
  ) {
    return "infrastructure";
  }
  if (
    /(?:^|\D)503(?:\D|$)/.test(`${code} ${message}`) ||
    /service[_ ]overloaded|temporarily unavailable/.test(message)
  ) {
    return "infrastructure";
  }
  return "task";
}

export function workerFailureNeedsCredentialAction(error: WorkerFailureInput): boolean {
  const message = error.message.toLowerCase();
  const code = error.code?.toLowerCase() ?? "";
  return (
    /(?:^|\D)(?:401|403)(?:\D|$)/.test(`${code} ${message}`) ||
    /unauthori[sz]ed|invalid api key|authentication credentials are invalid/.test(message)
  );
}

export const WORKER_INFRASTRUCTURE_RETRY_DELAYS_MS = [1_000, 5_000] as const;

export function workerInfrastructureRetryAt(
  retryCount: number,
  failedAt: Date,
): string | undefined {
  const delay = WORKER_INFRASTRUCTURE_RETRY_DELAYS_MS[retryCount];
  return delay === undefined ? undefined : new Date(failedAt.getTime() + delay).toISOString();
}
