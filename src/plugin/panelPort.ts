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
  hide(handle: string): Promise<void>;
  visible(handle: string): Promise<boolean>;
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
      '<!doctype html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'none\'; connect-src \'none\'; base-uri \'none\'; form-action \'none\'; frame-src \'none\'"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>',
    );
    await this.panels.addScript(this.handle, "./webview/base.css");
    await this.panels.addScript(this.handle, "./webview/layout.css");
    await this.panels.addScript(this.handle, "./webview/message.css");
    await this.panels.addScript(this.handle, "./webview/review.css");
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

  /**
   * Shows the initialized sidebar before composer-prefill delivery.
   *
   * @example await panel.show()
   */
  public async show(): Promise<void> {
    const handle = this.handle;
    if (!handle) {
      throw new Error(
        "Invalid panel handle null; expected an initialized panel",
      );
    }
    await this.panels.show(handle, true);
  }

  /**
   * Toggles the initialized sidebar using Joplin's current visibility state.
   *
   * @example await panel.toggleVisibility()
   */
  public async toggleVisibility(): Promise<void> {
    const handle = this.handle;
    if (!handle) {
      throw new Error(
        "Invalid panel handle null; expected an initialized panel",
      );
    }
    if (await this.panels.visible(handle)) {
      await this.panels.hide(handle);
      return;
    }
    await this.panels.show(handle, true);
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
