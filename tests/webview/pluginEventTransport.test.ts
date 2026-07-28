import { PROTOCOL_VERSION, type PluginEvent } from "../../src/shared/protocol";
import { parseWebviewPluginEvent } from "../../src/webview/pluginEventTransport";

const SNAPSHOT_EVENT: PluginEvent = {
  version: PROTOCOL_VERSION,
  messageId: "message-1",
  chatId: "chat-1",
  type: "state.snapshot",
  payload: {
    chats: [],
    activeChat: null,
    endpointStatus: "unconfigured",
    modelName: "",
    privacyNotice: "Context is opt-in.",
    secretNotebookIds: [],
  },
};

describe("parseWebviewPluginEvent", () => {
  test("accepts the direct event shape documented by Joplin", () => {
    expect(parseWebviewPluginEvent(SNAPSHOT_EVENT)).toEqual(SNAPSHOT_EVENT);
  });

  test("unwraps the JSON message envelope emitted by Joplin desktop", () => {
    const received = { message: JSON.stringify(SNAPSHOT_EVENT) };

    expect(parseWebviewPluginEvent(received)).toEqual(SNAPSHOT_EVENT);
  });

  test("rejects malformed wrapped JSON", () => {
    expect(() => parseWebviewPluginEvent({ message: "not JSON" })).toThrow(
      "expected a JSON-encoded plugin event",
    );
  });
});
