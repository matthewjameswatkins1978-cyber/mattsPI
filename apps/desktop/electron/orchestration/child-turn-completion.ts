import type { TranscriptMessage } from "../../contracts/desktop-state";

/**
 * An idle child session is complete only after its latest user turn has a
 * final assistant message. A tool result can leave the provider turn
 * unfinished (for example, if Pi exits before the model resumes after the
 * tool); treating that idle session as complete would let Studio integrate a
 * partial worker result.
 */
export function childTurnHasFinalAssistantMessage(
  transcript: readonly TranscriptMessage[],
): boolean {
  let latestUserIndex = -1;
  let latestWorkerItemIndex = -1;
  let latestWorkerItem: TranscriptMessage | undefined;

  transcript.forEach((item, index) => {
    if (item.kind === "message" && item.role === "user") latestUserIndex = index;
    if (item.kind === "tool" || (item.kind === "message" && item.role === "assistant")) {
      latestWorkerItemIndex = index;
      latestWorkerItem = item;
    }
  });

  return (
    latestWorkerItemIndex > latestUserIndex &&
    latestWorkerItem?.kind === "message" &&
    latestWorkerItem.role === "assistant"
  );
}
