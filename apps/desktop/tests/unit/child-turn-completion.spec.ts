import { expect, test } from "@playwright/test";
import type { TranscriptMessage } from "../../contracts/desktop-state";
import { childTurnHasFinalAssistantMessage } from "../../electron/orchestration/child-turn-completion";

const message = (
  role: "user" | "assistant",
  id: string,
): TranscriptMessage => ({ kind: "message", role, id, text: id, createdAt: "2026-09-29T00:00:00.000Z" });

const tool = (id: string): TranscriptMessage => ({
  kind: "tool",
  id,
  callId: id,
  toolName: "powershell",
  status: "success",
  createdAt: "2026-09-29T00:00:00.000Z",
});

test("does not treat an idle transcript ending in a tool result as complete", () => {
  expect(childTurnHasFinalAssistantMessage([message("user", "prompt"), message("assistant", "checking"), tool("result")])).toBe(false);
});

test("completes only when the latest user turn has a final assistant response", () => {
  expect(childTurnHasFinalAssistantMessage([
    message("user", "prompt"),
    message("assistant", "checking"),
    tool("result"),
    message("assistant", "finished"),
  ])).toBe(true);
});

test("an unfinished follow-up does not inherit the prior turn's completion", () => {
  expect(childTurnHasFinalAssistantMessage([
    message("user", "first prompt"),
    message("assistant", "first completion"),
    message("user", "follow-up"),
    message("assistant", "working"),
    tool("follow-up result"),
  ])).toBe(false);
});

test("a child with no worker response is not complete", () => {
  expect(childTurnHasFinalAssistantMessage([message("user", "prompt")])).toBe(false);
});
