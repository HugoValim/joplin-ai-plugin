import type { PanelRequest } from "../shared/protocol";
import type { ChangeReviewIntent, ChangeReviewTransport } from "./ChangeReview";

type RequestEnvelope = Pick<PanelRequest, "version" | "messageId" | "chatId">;

export interface ChangeReviewTransportPorts {
  readonly envelope: () => RequestEnvelope;
  readonly begin: (runId: string, phase: string) => void;
  readonly post: (request: PanelRequest) => void;
}

/**
 * Adapts ChangeReview intents to the versioned panel protocol.
 *
 * @example new ChangeReviewTransportAdapter(ports).send(intent)
 */
export class ChangeReviewTransportAdapter implements ChangeReviewTransport {
  public constructor(private readonly ports: ChangeReviewTransportPorts) {}

  public readonly send = (intent: ChangeReviewIntent): void => {
    if ("phase" in intent) this.ports.begin(intent.runId, intent.phase);
    this.ports.post(toPanelRequest(intent, this.ports.envelope()));
  };
}

function toPanelRequest(
  intent: ChangeReviewIntent,
  envelope: RequestEnvelope,
): PanelRequest {
  const runEnvelope = { ...envelope, runId: intent.runId };
  switch (intent.type) {
    case "apply":
      return {
        ...runEnvelope,
        type: "changes.apply",
        payload: {
          changeSetId: intent.changeSetId,
          acceptedIds: [...intent.acceptedIds],
          applyToken: intent.applyToken,
        },
      };
    case "discard":
      return changeSetRequest(
        runEnvelope,
        "changes.discard",
        intent.changeSetId,
      );
    case "deny":
      return changeSetRequest(runEnvelope, "changes.deny", intent.changeSetId);
    case "keep":
      return changeIdsRequest(runEnvelope, "changes.keep", intent);
    case "undo":
      return changeIdsRequest(runEnvelope, "changes.undo", intent);
    case "open":
      return changeSetRequest(runEnvelope, "review.open", intent.changeSetId);
  }
}

function changeSetRequest(
  envelope: RequestEnvelope & { readonly runId: string },
  type: "changes.discard" | "changes.deny" | "review.open",
  changeSetId: string,
): PanelRequest {
  return { ...envelope, type, payload: { changeSetId } };
}

function changeIdsRequest(
  envelope: RequestEnvelope & { readonly runId: string },
  type: "changes.keep" | "changes.undo",
  intent: Extract<ChangeReviewIntent, { type: "keep" | "undo" }>,
): PanelRequest {
  return {
    ...envelope,
    type,
    payload: {
      changeSetId: intent.changeSetId,
      changeIds: [...intent.changeIds],
    },
  };
}
