import type {
  OrchestrationChildThread,
  OrchestrationChildTranscriptMessage,
  OrchestrationEvidenceRecord,
  TranscriptMessage,
} from "../../contracts/desktop-state";
import type { StudioMilestone, StudioRun } from "../../contracts/studio-runs";

export function assertNewStudioMilestoneCompletionsHaveEvidence(
  current: StudioRun | undefined,
  next: StudioRun,
  children: readonly OrchestrationChildThread[],
  coordinatorTranscript: readonly TranscriptMessage[] = [],
): void {
  for (const milestone of next.milestones) {
    const wasComplete =
      current?.milestones.find(({ id }) => id === milestone.id)?.status === "complete";
    if (milestone.status === "complete" && !wasComplete) {
      if (milestone.verificationRequirement === "coordinator") {
        assertStudioMilestoneHasCoordinatorVerification(next, milestone, coordinatorTranscript);
      } else {
        assertStudioMilestoneHasIndependentVerification(next, milestone, children);
      }
    }
  }
}

export function assertStudioMilestoneHasCoordinatorVerification(
  run: Pick<StudioRun, "workspaceId" | "coordinatorSessionId">,
  milestone: StudioMilestone,
  transcript: readonly TranscriptMessage[],
): void {
  if (!run.coordinatorSessionId) {
    throw new Error("Coordinator verification requires the saved Studio coordinator thread.");
  }
  if (milestone.deliveryRequirement !== "local") {
    throw new Error("Coordinator verification is allowed only for a local milestone.");
  }
  if (milestone.workerThreadIds.length > 0 || milestone.worktreeIds.length > 0) {
    throw new Error(
      "Delegated Studio work requires an independent-inspector child; coordinator verification cannot downgrade it.",
    );
  }
  if (!hasSuccessfulCoordinatorTest(transcript)) {
    throw new Error(
      `Milestone ${milestone.id} coordinator verification has no successful specification-relevant check evidence.`,
    );
  }
  if (!hasCoordinatorGitInspection(transcript)) {
    throw new Error(
      `Milestone ${milestone.id} coordinator verification has no successful Git diff/status inspection evidence.`,
    );
  }
  if (!hasCoordinatorPassMarker(transcript, milestone.id)) {
    throw new Error(
      `Milestone ${milestone.id} coordinator must finish with "COORDINATOR-VERIFIED: ${milestone.id} PASS".`,
    );
  }
}

function commandFromTranscriptTool(message: TranscriptMessage): string | undefined {
  if (message.kind !== "tool" || message.status !== "success") return undefined;
  if (typeof message.input !== "object" || message.input === null || Array.isArray(message.input)) {
    return undefined;
  }
  const input = message.input as Record<string, unknown>;
  for (const key of ["cmd", "command", "script"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function hasSuccessfulCoordinatorTest(transcript: readonly TranscriptMessage[]): boolean {
  return transcript.some((message) => {
    const command = commandFromTranscriptTool(message);
    return Boolean(
      command &&
        /\b(test|spec|typecheck|build|playwright|vitest|jest|tsc|check)\b/i.test(command),
    );
  });
}

function hasCoordinatorGitInspection(transcript: readonly TranscriptMessage[]): boolean {
  return transcript.some((message) => {
    const command = commandFromTranscriptTool(message);
    return Boolean(command && /\bgit\s+(diff|show|status)\b/i.test(command));
  });
}

function hasCoordinatorPassMarker(
  transcript: readonly TranscriptMessage[],
  milestoneId: string,
): boolean {
  const expected = `COORDINATOR-VERIFIED: ${milestoneId} PASS`.toLowerCase();
  const finalAssistant = [...transcript]
    .reverse()
    .find((message) => message.kind === "message" && message.role === "assistant");
  return Boolean(
    finalAssistant?.kind === "message" &&
      finalAssistant.text
        .split("\n")
        .some((line) => line.trim().toLowerCase() === expected),
  );
}

/**
 * Prevents a coordinator from accepting a milestone using only a worker's completion claim.
 * The inspector, test command, and parent read are derived from Pi's runtime child-thread records.
 */
export function assertStudioMilestoneHasIndependentVerification(
  run: Pick<StudioRun, "workspaceId" | "coordinatorSessionId">,
  milestone: StudioMilestone,
  children: readonly OrchestrationChildThread[],
): void {
  if (!run.coordinatorSessionId) {
    throw new Error("A milestone cannot pass verification without its coordinator thread.");
  }
  const childIds = new Set(milestone.workerThreadIds);
  const inspector = children.find(
    (child) =>
      childIds.has(child.id) &&
      child.parentWorkspaceId === run.workspaceId &&
      child.parentSessionId === run.coordinatorSessionId &&
      child.role?.trim().toLowerCase().replaceAll("_", "-") === "independent-inspector",
  );
  if (!inspector) {
    throw new Error(
      `Milestone ${milestone.id} needs a linked independent-inspector child from this coordinator.`,
    );
  }
  if (inspector.status !== "complete") {
    throw new Error(`Milestone ${milestone.id} verifier thread has not completed.`);
  }
  if (!hasPassedTestCommand(inspector.evidence)) {
    throw new Error(
      `Milestone ${milestone.id} verifier has no successful specification-relevant check evidence.`,
    );
  }
  if (!hasInspectedRepositoryDiff(inspector.evidence)) {
    throw new Error(
      `Milestone ${milestone.id} verifier has no successful Git diff/status inspection evidence.`,
    );
  }
  if (!hasPassVerdict(inspector.transcript)) {
    throw new Error(
      `Milestone ${milestone.id} inspector must finish with an explicit PASS verdict.`,
    );
  }
  if (!hasParentReadInspectorOutput(inspector.evidence)) {
    throw new Error(
      `The Studio coordinator must read the independent-inspector thread before accepting ${milestone.id}.`,
    );
  }
}

function hasPassVerdict(transcript: readonly OrchestrationChildTranscriptMessage[]): boolean {
  const finalChildMessage = [...transcript].reverse().find(({ role }) => role === "child");
  return Boolean(finalChildMessage && /^PASS(?:\b|:|\s|[-—])/i.test(finalChildMessage.text.trim()));
}

function hasPassedTestCommand(evidence: readonly OrchestrationEvidenceRecord[]): boolean {
  return evidence.some(
    (record) =>
      record.kind === "command" &&
      record.source === "command" &&
      record.status === "passed" &&
      record.title === "Test command run" &&
      Boolean(record.command),
  );
}

function hasInspectedRepositoryDiff(evidence: readonly OrchestrationEvidenceRecord[]): boolean {
  return evidence.some(
    (record) =>
      record.kind === "command" &&
      record.source === "command" &&
      record.status === "passed" &&
      Boolean(record.command && /\bgit\s+(diff|show|status)\b/i.test(record.command)),
  );
}

function hasParentReadInspectorOutput(evidence: readonly OrchestrationEvidenceRecord[]): boolean {
  return evidence.some(
    (record) =>
      record.kind === "orchestrator_observation" &&
      record.source === "orchestrator-observed" &&
      record.status === "reported" &&
      record.title === "Orchestrator read child output",
  );
}
