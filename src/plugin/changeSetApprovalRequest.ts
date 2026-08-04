import { randomUUID } from "crypto";
import type { ChangeSet } from "../persistence/changeSetStore";
import type { ChangeSetApplyInput } from "../persistence/changeSetLifecycle";
import { PROTOCOL_VERSION, type PanelRequest } from "../shared/protocol";

export function automaticApplyRequest(
  changeSet: ChangeSet,
  acceptedChangeIds: string[],
  applyToken: string,
): Extract<PanelRequest, { type: "changes.apply" }> {
  return {
    version: PROTOCOL_VERSION,
    messageId: randomUUID(),
    chatId: changeSet.chatId,
    runId: changeSet.runId,
    type: "changes.apply",
    payload: {
      changeSetId: changeSet.id,
      acceptedIds: acceptedChangeIds,
      applyToken,
    },
  };
}

export function toChangeSetApplyInput(
  request: Extract<PanelRequest, { type: "changes.apply" }>,
  automatic: boolean,
): ChangeSetApplyInput {
  return {
    chatId: request.chatId,
    runId: request.runId,
    changeSetId: request.payload.changeSetId,
    acceptedChangeIds: request.payload.acceptedIds,
    applyToken: request.payload.applyToken,
    automatic,
  };
}
