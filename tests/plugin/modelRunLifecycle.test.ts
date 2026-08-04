import type {
  AiProvider,
  ProviderEvent,
  StreamChatRequest,
} from "../../src/providers/types";
import { InMemoryChangeSetStore } from "../../src/persistence/changeSetStore";
import { ChatStore } from "../../src/persistence/chatStore";
import { ModelRunLifecycle } from "../../src/plugin/modelRunLifecycle";
import type { PanelPort } from "../../src/plugin/panelPort";
import { PluginEventSender } from "../../src/plugin/pluginEventSender";
import { RunCancellationRegistry } from "../../src/plugin/runCancellationRegistry";
import type { PluginEvent } from "../../src/shared/protocol";
import { ToolRegistry } from "../../src/tools/toolRegistry";
import { MemoryJsonFilePort } from "../fakes/memoryJsonFilePort";

class TextProvider implements AiProvider {
  public lastRequest: StreamChatRequest | null = null;

  public constructor(private readonly text: string) {}

  public async *streamChat(
    _request: StreamChatRequest,
    _abortSignal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    this.lastRequest = _request;
    yield { type: "text-delta", delta: this.text };
    yield { type: "completed", finishReason: "stop" };
  }

  public async testConnection(): Promise<void> {}
  public async listModels(): Promise<readonly string[]> {
    return [];
  }
  public async contextWindow(): Promise<number | null> {
    return null;
  }
  public async modelAvailable(): Promise<boolean> {
    return true;
  }
}

class FailingProvider extends TextProvider {
  public override async *streamChat(): AsyncIterable<ProviderEvent> {
    throw new Error("transport leaked detail");
  }
}

class RecordingPanel implements PanelPort {
  public readonly events: PluginEvent[] = [];

  public async initialize(): Promise<void> {}

  public post(event: PluginEvent): void {
    this.events.push(event);
  }
}

describe("ModelRunLifecycle", () => {
  test("starts, streams, persists, and releases an initial model run", async () => {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    const chat = await chats.create("Lifecycle");
    const panel = new RecordingPanel();
    const activeRuns = new RunCancellationRegistry();
    const lifecycle = new ModelRunLifecycle(
      chats,
      new ToolRegistry(),
      new InMemoryChangeSetStore(),
      new PluginEventSender(panel),
      activeRuns,
    );

    await lifecycle.start({
      chatId: chat.id,
      runId: "run-1",
      prepare: async () => ({
        provider: new TextProvider("Done"),
        submittedChat: chat,
        citations: [],
        request: {
          messages: [{ role: "user", content: "Work" }],
          hasFileWorkspace: false,
          vault: false,
          readOnly: false,
          readableNoteIds: new Set<string>(),
          secretNotebookIds: new Set<string>(),
        },
      }),
      onOutcome: async () => {},
    });

    expect((await chats.get(chat.id))?.messages.at(-1)?.content).toBe("Done");
    expect(panel.events.map((event) => event.type)).toEqual([
      "run.started",
      "run.progress",
      "assistant.delta",
    ]);
    expect(activeRuns.has(chat.id)).toBe(false);
  });

  test("normalizes and persists an initial run failure", async () => {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    const chat = await chats.create("Failure");
    const panel = new RecordingPanel();
    const activeRuns = new RunCancellationRegistry();
    const lifecycle = new ModelRunLifecycle(
      chats,
      new ToolRegistry(),
      new InMemoryChangeSetStore(),
      new PluginEventSender(panel),
      activeRuns,
    );
    const failures: string[] = [];

    await lifecycle.start({
      chatId: chat.id,
      runId: "run-failed",
      prepare: async () => ({
        provider: new FailingProvider(""),
        submittedChat: chat,
        citations: [],
        request: {
          messages: [],
          hasFileWorkspace: false,
          vault: false,
          readOnly: false,
          readableNoteIds: new Set<string>(),
          secretNotebookIds: new Set<string>(),
        },
      }),
      onOutcome: async () => {},
      onFailure: async (failure) => {
        failures.push(`${failure.code}:${failure.message}`);
      },
    });

    expect(failures).toEqual(["PROVIDER:Unexpected agent failure"]);
    expect((await chats.get(chat.id))?.runSummaries.at(-1)).toMatchObject({
      runId: "run-failed",
      status: "failed",
      summary: "Unexpected agent failure",
    });
    expect(panel.events.at(-1)).toMatchObject({
      type: "run.failed",
      payload: { code: "PROVIDER", message: "Unexpected agent failure" },
    });
    expect(activeRuns.has(chat.id)).toBe(false);
  });

  test("persists a cancelled initial run and releases registration", async () => {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    const chat = await chats.create("Cancellation");
    const panel = new RecordingPanel();
    const activeRuns = new RunCancellationRegistry();
    const lifecycle = new ModelRunLifecycle(
      chats,
      new ToolRegistry(),
      new InMemoryChangeSetStore(),
      new PluginEventSender(panel),
      activeRuns,
    );

    const completion = lifecycle.start({
      chatId: chat.id,
      runId: "run-cancelled",
      prepare: async () => ({
        provider: new TextProvider("unused"),
        submittedChat: chat,
        citations: [],
        request: {
          messages: [],
          hasFileWorkspace: false,
          vault: false,
          readOnly: false,
          readableNoteIds: new Set<string>(),
          secretNotebookIds: new Set<string>(),
        },
      }),
      onOutcome: async () => {},
    });
    activeRuns.cancel(chat.id, "run-cancelled");
    await completion;

    expect((await chats.get(chat.id))?.runSummaries.at(-1)).toMatchObject({
      runId: "run-cancelled",
      status: "cancelled",
      summary: "Agent run cancelled",
    });
    expect(panel.events.at(-1)).toMatchObject({
      type: "run.failed",
      payload: { code: "ABORTED", message: "Agent run cancelled" },
    });
    expect(activeRuns.has(chat.id)).toBe(false);
  });

  test("resumes, streams, and persists a continuation run", async () => {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    const chat = await chats.create("Continuation");
    const provider = new TextProvider("Continued");
    const panel = new RecordingPanel();
    const activeRuns = new RunCancellationRegistry();
    const lifecycle = new ModelRunLifecycle(
      chats,
      new ToolRegistry(),
      new InMemoryChangeSetStore(),
      new PluginEventSender(panel),
      activeRuns,
    );

    await lifecycle.resume({
      chatId: chat.id,
      runId: "run-resumed",
      continuation: {
        messages: [{ role: "assistant", content: "Proposal" }],
        nextStep: 2,
        toolCallCount: 1,
        plan: null,
      },
      approvalSummary: "Approved",
      citations: [],
      prepare: async () => ({
        provider,
        request: {
          messages: [],
          hasFileWorkspace: false,
          vault: false,
          readOnly: false,
          readableNoteIds: new Set<string>(),
          secretNotebookIds: new Set<string>(),
        },
      }),
      onOutcome: async () => {},
    });

    expect(provider.lastRequest?.messages).toContainEqual({
      role: "user",
      content: "Approved",
    });
    expect((await chats.get(chat.id))?.messages.at(-1)?.content).toBe(
      "Continued",
    );
    expect(panel.events.map((event) => event.type)).toEqual([
      "run.started",
      "run.progress",
      "assistant.delta",
    ]);
    expect(activeRuns.has(chat.id)).toBe(false);
  });

  test("normalizes continuation failure without persisting a second summary", async () => {
    const chats = new ChatStore("/plugin", new MemoryJsonFilePort());
    const chat = await chats.create("Continuation failure");
    const panel = new RecordingPanel();
    const activeRuns = new RunCancellationRegistry();
    const lifecycle = new ModelRunLifecycle(
      chats,
      new ToolRegistry(),
      new InMemoryChangeSetStore(),
      new PluginEventSender(panel),
      activeRuns,
    );
    const failures: string[] = [];

    await lifecycle.resume({
      chatId: chat.id,
      runId: "run-resume-failed",
      continuation: {
        messages: [],
        nextStep: 1,
        toolCallCount: 0,
        plan: null,
      },
      approvalSummary: "Approved",
      citations: [],
      prepare: async () => ({
        provider: new FailingProvider(""),
        request: {
          messages: [],
          hasFileWorkspace: false,
          vault: false,
          readOnly: false,
          readableNoteIds: new Set<string>(),
          secretNotebookIds: new Set<string>(),
        },
      }),
      onOutcome: async () => {},
      onFailure: (failure) => {
        failures.push(`${failure.code}:${failure.message}`);
      },
    });

    expect(failures).toEqual(["INTERNAL:Unexpected continuation failure"]);
    expect((await chats.get(chat.id))?.runSummaries).toEqual([]);
    expect(panel.events.at(-1)).toMatchObject({
      type: "run.failed",
      payload: {
        code: "INTERNAL",
        message: "Unexpected continuation failure",
      },
    });
    expect(activeRuns.has(chat.id)).toBe(false);
  });
});
