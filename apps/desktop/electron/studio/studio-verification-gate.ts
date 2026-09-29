import type {
  OrchestrationChildThread,
  OrchestrationChildTranscriptMessage,
  OrchestrationEvidenceRecord,
} from "../../contracts/desktop-state";
import type { StudioMilestone, StudioRun } from "../../contracts/studio-runs";

export function assertNewStudioMilestoneCompletionsHaveEvidence(
  current: StudioRun | undefined,
  next: StudioRun,
  children: readonly OrchestrationChildThread[],
): void {
  for (const milestone of next.milestones) {
    const wasComplete =
      current?.milestones.find(({ id }) => id === milestone.id)?.status === "complete";
    if (milestone.status === "complete" && !wasComplete) {
      assertStudioMilestoneHasIndependentVerification(next, milestone, children);
    }
  }
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
