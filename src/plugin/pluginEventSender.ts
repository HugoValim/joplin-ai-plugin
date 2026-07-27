import { randomUUID } from "crypto";
import {
  PROTOCOL_VERSION,
  parsePluginEvent,
  type PluginEvent,
} from "../shared/protocol";
import type { PanelPort } from "./panelPort";

export class PluginEventSender {
  public constructor(private readonly panel: PanelPort) {}

  public post(
    type: PluginEvent["type"],
    chatId: string,
    payload: unknown,
    runId?: string,
  ): void {
    const event = parsePluginEvent({
      version: PROTOCOL_VERSION,
      messageId: randomUUID(),
      chatId,
      ...(runId ? { runId } : {}),
      type,
      payload,
    });
    this.panel.post(event);
  }
}
