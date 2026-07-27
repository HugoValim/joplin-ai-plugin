import { DomainError } from "../../src/shared/errors";
import { JoplinPanelPort } from "../../src/plugin/panelPort";

type MessageCallback = (message: unknown) => Promise<unknown>;

class FakePanelsPort {
  public readonly posted: unknown[] = [];
  public readonly scripts: string[] = [];
  public callback: MessageCallback | null = null;

  public async create(): Promise<string> {
    return "panel-1";
  }

  public async setHtml(): Promise<string> {
    return "panel-1";
  }

  public async addScript(_handle: string, scriptPath: string): Promise<void> {
    this.scripts.push(scriptPath);
    return Promise.resolve();
  }

  public async onMessage(
    _handle: string,
    callback: MessageCallback,
  ): Promise<void> {
    this.callback = callback;
  }

  public postMessage(_handle: string, message: unknown): void {
    this.posted.push(message);
  }

  public async show(): Promise<void> {
    return Promise.resolve();
  }
}

describe("JoplinPanelPort", () => {
  test("loads split styles in deterministic order before the webview bundle", async () => {
    const panels = new FakePanelsPort();
    const panel = new JoplinPanelPort(panels, jest.fn());

    await panel.initialize(async () => Promise.resolve());

    expect(panels.scripts).toEqual([
      "./webview/base.css",
      "./webview/layout.css",
      "./webview/message.css",
      "./webview/review.css",
      "./webview/index.js",
    ]);
  });

  test("returns typed run failure when a validated request fails", async () => {
    const panels = new FakePanelsPort();
    const reported: unknown[] = [];
    const panel = new JoplinPanelPort(panels, (error) => reported.push(error));
    await panel.initialize(async () => {
      throw new DomainError("CONFLICT", "Concurrent change");
    });
    if (!panels.callback) throw new Error("Expected message callback");

    await panels.callback({
      version: 2,
      messageId: "message-1",
      chatId: "chat-1",
      runId: "run-1",
      type: "changes.apply",
      payload: { changeSetId: "changes-1", acceptedIds: [] },
    });

    expect(panels.posted).toContainEqual(
      expect.objectContaining({
        type: "run.failed",
        chatId: "chat-1",
        runId: "run-1",
        payload: { code: "CONFLICT", message: "Concurrent change" },
      }),
    );
    expect(reported).toHaveLength(1);
  });
});
