import { randomUUID } from "crypto";
import type { PluginEvent, PanelRequest } from "../shared/protocol";
import {
  PROTOCOL_VERSION,
  parsePanelRequest,
  parsePluginEvent,
} from "../shared/protocol";
import { DomainError } from "../shared/errors";

type PanelRequestListener = (request: PanelRequest) => Promise<void>;

interface JoplinPanelsPort {
  create(id: string): Promise<string>;
  setHtml(handle: string, html: string): Promise<string>;
  addScript(handle: string, scriptPath: string): Promise<void>;
  onMessage(
    handle: string,
    callback: (message: unknown) => Promise<unknown>,
  ): Promise<void>;
  postMessage(handle: string, message: unknown): void;
  show(handle: string, show?: boolean): Promise<void>;
}

export interface PanelPort {
  initialize(listener: PanelRequestListener): Promise<void>;
  post(event: PluginEvent): void;
}

export class JoplinPanelPort implements PanelPort {
  private handle: string | null = null;

  public constructor(
    private readonly panels: JoplinPanelsPort,
    private readonly onInvalidMessage: (error: unknown) => void,
  ) {}

  /**
   * Creates the React sidebar and validates every message crossing from its webview.
   *
   * @example await panel.initialize(handleRequest)
   */
  public async initialize(listener: PanelRequestListener): Promise<void> {
    this.handle = await this.panels.create("joplinAiAgentSidebar");
    await this.panels.setHtml(
      this.handle,
      '<!doctype html><html><body><div id="root"></div></body></html>',
    );
    await this.panels.addScript(this.handle, "./webview/style.css");
    await this.panels.addScript(this.handle, "./webview/index.js");
    await this.panels.onMessage(this.handle, async (input) => {
      let request: PanelRequest;
      try {
        request = parsePanelRequest(input);
      } catch (error: unknown) {
        this.onInvalidMessage(error);
        return null;
      }
      try {
        await listener(request);
      } catch (error: unknown) {
        this.reportRequestFailure(request, error);
      }
      return null;
    });
    await this.panels.show(this.handle, true);
  }

  /**
   * Sends a validated protocol event to the credential-free sidebar process.
   *
   * @example panel.post(runStartedEvent)
   */
  public post(event: PluginEvent): void {
    if (!this.handle) return;
    this.panels.postMessage(this.handle, parsePluginEvent(event));
  }

  private reportRequestFailure(request: PanelRequest, error: unknown): void {
    this.onInvalidMessage(error);
    if (!("runId" in request)) return;
    const domain =
      error instanceof DomainError
        ? error
        : new DomainError("INTERNAL", "Unexpected plugin request failure");
    this.post({
      version: PROTOCOL_VERSION,
      messageId: randomUUID(),
      chatId: request.chatId,
      runId: request.runId,
      type: "run.failed",
      payload: { code: domain.code, message: domain.message },
    });
  }
}
