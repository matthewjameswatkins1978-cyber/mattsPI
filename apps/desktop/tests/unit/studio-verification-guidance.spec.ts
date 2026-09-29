import { expect, test } from "@playwright/test";
import {
  createOrchestrationRuntimeTools,
  saveStudioRunToolName,
  type OrchestrationRuntimeBridge,
} from "../../electron/orchestration/orchestration-runtime";

test("Studio coordinator instructions require independent evidence and bounded repair", () => {
  const saveTool = createOrchestrationRuntimeTools(
    {} as unknown as OrchestrationRuntimeBridge,
  ).find(({ name }) => name === saveStudioRunToolName);
  expect(saveTool).toBeDefined();
  const guidance = saveTool!.promptGuidelines.join(" ");
  expect(guidance).toContain("worker's completion message as a claim, not acceptance");
  expect(guidance).toContain("at most two Studio child workers active at once");
  expect(guidance).toContain("never silently switch to a metered route");
  expect(guidance).toContain("role independent-inspector");
  expect(guidance).toContain("INCONCLUSIVE is not PASS");
  expect(guidance).toContain("at most two repair attempts");
  expect(guidance).toContain("pending Lucy review does not stop other dependency-ready milestones");
});
