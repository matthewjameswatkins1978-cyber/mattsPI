import { expect, test } from "@playwright/test";
import {
  classifyWorkerFailure,
  workerFailureNeedsCredentialAction,
  workerInfrastructureRetryAt,
} from "../../contracts/worker-failure";

test("quota and provider overload are infrastructure failures, while engineering errors stay task failures", () => {
  expect(classifyWorkerFailure({ code: "HTTP_429", message: "quota exhausted" })).toBe(
    "infrastructure",
  );
  expect(classifyWorkerFailure({ message: "meta API error (503): service_overloaded" })).toBe(
    "infrastructure",
  );
  expect(classifyWorkerFailure({ message: "TypeScript compilation failed" })).toBe("task");
  expect(classifyWorkerFailure({ message: "authentication credentials are invalid" })).toBe(
    "infrastructure",
  );
  expect(workerFailureNeedsCredentialAction({ code: "HTTP_401", message: "unauthorized" })).toBe(
    true,
  );
});

test("infrastructure retries are bounded with increasing delays and retain no route choice", () => {
  const failedAt = new Date("2026-10-07T12:00:00.000Z");
  expect(workerInfrastructureRetryAt(0, failedAt)).toBe("2026-10-07T12:00:01.000Z");
  expect(workerInfrastructureRetryAt(1, failedAt)).toBe("2026-10-07T12:00:05.000Z");
  expect(workerInfrastructureRetryAt(2, failedAt)).toBeUndefined();
});
