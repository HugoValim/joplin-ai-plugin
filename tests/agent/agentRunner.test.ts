import { Type } from "@sinclair/typebox";
import type {
  AiProvider,
  ProviderEvent,
  StreamChatRequest,
} from "../../src/providers/types";
import { InMemoryChangeSetStore } from "../../src/persistence/changeSetStore";
import { AgentRunner } from "../../src/agent/agentRunner";
import { registerAgentPlanTools } from "../../src/tools/agentPlanTools";
import {
  ToolRegistry,
  type AgentTool,
  type ToolExecutionContext,
} from "../../src/tools/toolRegistry";

class RepeatingToolProvider implements AiProvider {
  public callCount = 0;

  public constructor(private readonly toolsPerStep = 1) {}

  public async *streamChat(
    _request: StreamChatRequest,
    _abortSignal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    this.callCount += 1;
    const calls = Array.from({ length: this.toolsPerStep }, (_, index) => ({
      id: `call-${this.callCount}-${index + 1}`,
      name: "echo",
      arguments: {},
    }));
    yield { type: "tool-calls", calls };
    yield { type: "completed", finishReason: "tool_calls" };
  }

  public async testConnection(): Promise<void> {
    return Promise.resolve();
  }

  public async listModels(): Promise<readonly string[]> {
    return [];
  }

  public async modelAvailable(): Promise<boolean> {
    return true;
  }

  public async contextWindow(): Promise<number | null> {
    return null;
  }
}

class EchoTool implements AgentTool<Record<string, never>, { ok: boolean }> {
  public readonly name = "echo";
  public readonly description = "Return success";
  public readonly risk = "read" as const;
  public readonly inputSchema = Type.Object(
    {},
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object({ ok: Type.Boolean() });

  public isAvailable(): boolean {
    return true;
  }

  public async execute(
    _input: Record<string, never>,
    _context: ToolExecutionContext,
  ): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}

/** Named like a real content-read tool so it counts toward the read budget. */
class ContentReadTool implements AgentTool<
  Record<string, never>,
  { ok: boolean }
> {
  public readonly name = "read_note";
  public readonly description = "Read a note body";
  public readonly risk = "read" as const;
  public readonly inputSchema = Type.Object(
    {},
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object({ ok: Type.Boolean() });

  public isAvailable(): boolean {
    return true;
  }

  public async execute(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}

class ListTool implements AgentTool<
  Record<string, never>,
  {
    notebooks: readonly {
      id: string;
      title: string;
      parent_id: string;
    }[];
  }
> {
  public readonly name = "list_notebooks";
  public readonly description = "List notebooks";
  public readonly risk = "read" as const;
  public readonly inputSchema = Type.Object(
    {},
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object({
    notebooks: Type.Array(
      Type.Object({
        id: Type.String(),
        title: Type.String(),
        parent_id: Type.String(),
      }),
    ),
  });

  public isAvailable(): boolean {
    return true;
  }

  public async execute(): Promise<{
    notebooks: readonly {
      id: string;
      title: string;
      parent_id: string;
    }[];
  }> {
    return {
      notebooks: [
        { id: "nb-1", title: "RF", parent_id: "" },
        { id: "nb-2", title: "Tools", parent_id: "" },
      ],
    };
  }
}

class ListNotebookNotesTool implements AgentTool<
  { notebook_id: string },
  {
    notes: readonly {
      id: string;
      title: string;
      updated_time: number;
      order: number;
    }[];
  }
> {
  public readonly name = "list_notebook_notes";
  public readonly description = "List notes in a notebook";
  public readonly risk = "read" as const;
  public readonly inputSchema = Type.Object(
    { notebook_id: Type.String({ minLength: 1 }) },
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object({
    notes: Type.Array(
      Type.Object({
        id: Type.String(),
        title: Type.String(),
        updated_time: Type.Number(),
        order: Type.Number(),
      }),
    ),
  });

  public isAvailable(): boolean {
    return true;
  }

  public async execute(input: { notebook_id: string }): Promise<{
    notes: readonly {
      id: string;
      title: string;
      updated_time: number;
      order: number;
    }[];
  }> {
    return {
      notes: [
        {
          id: `${input.notebook_id}-n1`,
          title: "Intro",
          updated_time: 1,
          order: 0,
        },
        {
          id: `${input.notebook_id}-n2`,
          title: "Links",
          updated_time: 1,
          order: 1,
        },
      ],
    };
  }
}

class SingleProposalProvider implements AiProvider {
  public callCount = 0;

  public async *streamChat(): AsyncIterable<ProviderEvent> {
    this.callCount += 1;
    yield {
      type: "tool-calls",
      calls: [{ id: "proposal-1", name: "propose", arguments: {} }],
    };
    yield { type: "completed", finishReason: "tool_calls" };
  }

  public async testConnection(): Promise<void> {
    return Promise.resolve();
  }

  public async listModels(): Promise<readonly string[]> {
    return [];
  }

  public async modelAvailable(): Promise<boolean> {
    return true;
  }

  public async contextWindow(): Promise<number | null> {
    return null;
  }
}

class ProposalThenTextProvider implements AiProvider {
  public callCount = 0;

  public async *streamChat(): AsyncIterable<ProviderEvent> {
    this.callCount += 1;
    if (this.callCount === 1) {
      yield {
        type: "tool-calls",
        calls: [{ id: "proposal-1", name: "propose", arguments: {} }],
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text-delta", delta: "Applied and complete." };
    yield { type: "completed", finishReason: "stop" };
  }

  public async testConnection(): Promise<void> {
    return Promise.resolve();
  }

  public async listModels(): Promise<readonly string[]> {
    return [];
  }

  public async modelAvailable(): Promise<boolean> {
    return true;
  }

  public async contextWindow(): Promise<number | null> {
    return null;
  }
}

class ProposeTool implements AgentTool<
  Record<string, never>,
  { change_id: string }
> {
  public readonly name = "propose";
  public readonly description = "Collect a proposal";
  public readonly risk = "propose-write" as const;
  public readonly inputSchema = Type.Object(
    {},
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object({ change_id: Type.String() });

  public constructor(private readonly changes: InMemoryChangeSetStore) {}

  public isAvailable(): boolean {
    return true;
  }

  public async execute(
    _input: Record<string, never>,
    context: ToolExecutionContext,
  ): Promise<{ change_id: string }> {
    const change = this.changes.add(context.chatId, context.runId, {
      kind: "file",
      relativePath: "guide.md",
      targetLabel: "guide.md",
      before: "old",
      after: "new",
      expectedSha256: "hash",
    });
    return { change_id: change.id };
  }
}

describe("AgentRunner", () => {
  test("stops after the safety model-step limit when tools never finish", async () => {
    const provider = new RepeatingToolProvider();
    const registry = new ToolRegistry();
    registry.register(new EchoTool());
    const runner = new AgentRunner(
      provider,
      registry,
      new InMemoryChangeSetStore(),
    );

    await expect(
      runner.run(
        {
          chatId: "chat-1",
          runId: "run-1",
          messages: [{ role: "user", content: "Loop forever" }],
          hasFileWorkspace: false, vault: true, readOnly: false, readableNoteIds: new Set<string>(), secretNotebookIds: new Set<string>(),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("200 model steps");
    expect(provider.callCount).toBe(200);
  });

  test("does not cap tool call volume during a run", async () => {
    let calls = 0;
    const provider: AiProvider = {
      async *streamChat() {
        calls += 1;
        if (calls <= 3) {
          yield {
            type: "tool-calls",
            calls: Array.from({ length: 50 }, (_, index) => ({
              id: `call-${calls}-${index + 1}`,
              name: "echo",
              arguments: {},
            })),
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text-delta", delta: "Done after many reads." };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => undefined,
      listModels: async () => [],
      modelAvailable: async () => true,
      contextWindow: async () => null,
    };
    const registry = new ToolRegistry();
    registry.register(new EchoTool());
    const runner = new AgentRunner(
      provider,
      registry,
      new InMemoryChangeSetStore(),
    );

    const result = await runner.run(
      {
        chatId: "chat-1",
        runId: "run-1",
        messages: [{ role: "user", content: "Many tools" }],
        hasFileWorkspace: false,
        vault: true,
        readOnly: false,
        readableNoteIds: new Set<string>(),
        secretNotebookIds: new Set<string>(),
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    expect(calls).toBe(4);
    expect(result.assistantText).toBe("Done after many reads.");
  });

  test("pauses after collecting proposed writes", async () => {
    const provider = new SingleProposalProvider();
    const changes = new InMemoryChangeSetStore();
    const registry = new ToolRegistry();
    registry.register(new ProposeTool(changes));
    const runner = new AgentRunner(provider, registry, changes);

    const result = await runner.run(
      {
        chatId: "chat-1",
        runId: "run-1",
        messages: [{ role: "user", content: "Improve the guide" }],
        hasFileWorkspace: true, vault: true, readOnly: false, readableNoteIds: new Set<string>(), secretNotebookIds: new Set<string>(),
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("awaiting-approval");
    expect(result.changeSet?.changes).toHaveLength(1);
    expect(provider.callCount).toBe(1);
  });

  test("resumes after approval and returns results to the model", async () => {
    const provider = new ProposalThenTextProvider();
    const changes = new InMemoryChangeSetStore();
    const registry = new ToolRegistry();
    registry.register(new ProposeTool(changes));
    const runner = new AgentRunner(provider, registry, changes);
    const request = {
      chatId: "chat-1",
      runId: "run-1",
      messages: [{ role: "user" as const, content: "Improve the guide" }],
      hasFileWorkspace: true,
      vault: true,
      readOnly: false,
      readableNoteIds: new Set<string>(),
      secretNotebookIds: new Set<string>(),
    };
    const paused = await runner.run(request, new AbortController().signal);
    if (!paused.continuation) throw new Error("Expected continuation");

    const resumed = await runner.resume(
      { ...request, runId: "run-2" },
      paused.continuation,
      "Approval results: one change applied.",
      new AbortController().signal,
    );

    expect(resumed.status).toBe("completed");
    expect(resumed.assistantText).toBe("Applied and complete.");
    expect(resumed.messages.at(-2)).toEqual({
      role: "user",
      content: "Approval results: one change applied.",
    });
    expect(provider.callCount).toBe(2);
  });

  test("stops before contacting the provider when already cancelled", async () => {
    const provider = new RepeatingToolProvider();
    const registry = new ToolRegistry();
    registry.register(new EchoTool());
    const runner = new AgentRunner(
      provider,
      registry,
      new InMemoryChangeSetStore(),
    );
    const controller = new AbortController();
    controller.abort("user stopped");

    await expect(
      runner.run(
        {
          chatId: "chat-1",
          runId: "run-1",
          messages: [{ role: "user", content: "Do not run" }],
          hasFileWorkspace: false, vault: true, readOnly: false, readableNoteIds: new Set<string>(), secretNotebookIds: new Set<string>(),
        },
        controller.signal,
      ),
    ).rejects.toThrow("Agent run cancelled");
    expect(provider.callCount).toBe(0);
  });

  test("returns invalid tool arguments to the model and continues the run", async () => {
    const provider = new InvalidThenRecoverProvider();
    const registry = new ToolRegistry();
    registry.register(new EchoTool());
    registry.register(new StrictMoveTool());
    const runner = new AgentRunner(
      provider,
      registry,
      new InMemoryChangeSetStore(),
    );

    const result = await runner.run(
      {
        chatId: "chat-1",
        runId: "run-soft-tool",
        messages: [{ role: "user", content: "move note to root" }],
        hasFileWorkspace: false,
        vault: true,
        readOnly: false,
        readableNoteIds: new Set<string>(),
        secretNotebookIds: new Set<string>(),
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    expect(result.assistantText).toBe("Recovered after bad tool args.");
    const toolMessage = result.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "bad-move",
    );
    expect(toolMessage?.role).toBe("tool");
    if (toolMessage?.role !== "tool") throw new Error("Expected tool message");
    expect(toolMessage.content).toContain("VALIDATION");
    expect(provider.callCount).toBe(2);
  });

  test("keeps reading when no propose-write tools exist", async () => {
    const provider = new RepeatingToolProvider();
    const registry = new ToolRegistry();
    registry.register(new EchoTool());
    const runner = new AgentRunner(
      provider,
      registry,
      new InMemoryChangeSetStore(),
    );

    await expect(
      runner.run(
        {
          chatId: "chat-1",
          runId: "run-nudge",
          messages: [{ role: "user", content: "Keep reading" }],
          hasFileWorkspace: false,
          vault: false,
        readOnly: false,
          readableNoteIds: new Set<string>(),
          secretNotebookIds: new Set<string>(),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("200 model steps");
    expect(provider.callCount).toBe(200);
  });

  test("disables content reads after eight read_note calls even in one parallel batch", async () => {
    const captured: StreamChatRequest[] = [];
    const changes = new InMemoryChangeSetStore();
    const provider: AiProvider = {
      async *streamChat(request, _signal) {
        captured.push(request);
        const names = request.tools.map((tool) => tool.name);
        if (names.includes("read_note")) {
          yield {
            type: "tool-calls",
            calls: Array.from({ length: 8 }, (_, index) => ({
              id: `read-${captured.length}-${index + 1}`,
              name: "read_note",
              arguments: {},
            })),
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield {
          type: "tool-calls",
          calls: [
            {
              id: `propose-${captured.length}`,
              name: "propose",
              arguments: {},
            },
          ],
        };
        yield { type: "completed", finishReason: "tool_calls" };
      },
      testConnection: async () => undefined,
      listModels: async () => [],
      modelAvailable: async () => true,
      contextWindow: async () => null,
    };
    const registry = new ToolRegistry();
    registry.register(new ContentReadTool());
    registry.register(new ProposeTool(changes));
    const runner = new AgentRunner(provider, registry, changes);

    const result = await runner.run(
      {
        chatId: "chat-1",
        runId: "run-hard-budget",
        messages: [{ role: "user", content: "Reorganize notebooks" }],
        hasFileWorkspace: false,
        vault: false,
        readOnly: false,
        readableNoteIds: new Set<string>(),
        secretNotebookIds: new Set<string>(),
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("awaiting-approval");
    expect(captured).toHaveLength(2);
    expect(captured[1]?.tools.map((tool) => tool.name)).toEqual(["propose"]);
    expect(
      captured[1]?.messages.some(
        (message) =>
          message.role === "system" &&
          message.content.includes("READ BUDGET EXCEEDED"),
      ),
    ).toBe(true);
  });

  test("does not count list tools toward the content-read budget", async () => {
    const captured: StreamChatRequest[] = [];
    const changes = new InMemoryChangeSetStore();
    const provider: AiProvider = {
      async *streamChat(request, _signal) {
        captured.push(request);
        if (captured.length === 1) {
          yield {
            type: "tool-calls",
            calls: Array.from({ length: 8 }, (_, index) => ({
              id: `list-${index + 1}`,
              name: "list_notebooks",
              arguments: {},
            })),
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text-delta", delta: "Listed notebooks." };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => undefined,
      listModels: async () => [],
      modelAvailable: async () => true,
      contextWindow: async () => null,
    };
    const registry = new ToolRegistry();
    registry.register(new ListTool());
    registry.register(new ProposeTool(changes));
    const runner = new AgentRunner(provider, registry, changes);

    const result = await runner.run(
      {
        chatId: "chat-1",
        runId: "run-list-budget",
        messages: [{ role: "user", content: "List everything" }],
        hasFileWorkspace: false,
        vault: false,
        readOnly: false,
        readableNoteIds: new Set<string>(),
        secretNotebookIds: new Set<string>(),
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    expect(captured).toHaveLength(2);
    expect(captured[1]?.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["list_notebooks", "propose"]),
    );
    expect(
      captured.some((request) =>
        request.messages.some(
          (message) =>
            message.role === "system" &&
            message.content.includes("READ BUDGET EXCEEDED"),
        ),
      ),
    ).toBe(false);
  });

  test("refuses text-only stop after multi-notebook inventory until plan and propose", async () => {
    const captured: StreamChatRequest[] = [];
    const changes = new InMemoryChangeSetStore();
    const provider: AiProvider = {
      async *streamChat(request, _signal) {
        captured.push(request);
        if (captured.length === 1) {
          yield {
            type: "tool-calls",
            calls: [
              { id: "nb", name: "list_notebooks", arguments: {} },
              ...Array.from({ length: 3 }, (_, index) => ({
                id: `notes-${index + 1}`,
                name: "list_notebook_notes",
                arguments: { notebook_id: `nb-${(index % 2) + 1}` },
              })),
            ],
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        if (captured.length === 2) {
          yield {
            type: "text-delta",
            delta: "Mapped the vault. I'll plan next session.",
          };
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        if (captured.length === 3) {
          yield {
            type: "tool-calls",
            calls: [
              {
                id: "plan-1",
                name: "set_agent_plan",
                arguments: {
                  items: [{ id: "1", content: "Improve FWS notes" }],
                },
              },
            ],
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        if (captured.length === 4) {
          yield {
            type: "text-delta",
            delta: "Plan ready. Say continue when you want edits.",
          };
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        yield {
          type: "tool-calls",
          calls: [{ id: "propose-1", name: "propose", arguments: {} }],
        };
        yield { type: "completed", finishReason: "tool_calls" };
      },
      testConnection: async () => undefined,
      listModels: async () => [],
      modelAvailable: async () => true,
      contextWindow: async () => null,
    };
    const registry = new ToolRegistry();
    registry.register(new ListTool());
    registry.register(new ListNotebookNotesTool());
    registerAgentPlanTools(registry);
    registry.register(new ProposeTool(changes));
    const runner = new AgentRunner(provider, registry, changes);

    const result = await runner.run(
      {
        chatId: "chat-1",
        runId: "run-force-plan",
        messages: [
          { role: "user", content: "Improve writing in all notes" },
        ],
        hasFileWorkspace: false,
        vault: false,
        readOnly: false,
        readableNoteIds: new Set<string>(),
        secretNotebookIds: new Set<string>(),
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("awaiting-approval");
    expect(
      captured.some((request) =>
        request.messages.some(
          (message) =>
            message.role === "system" &&
            message.content.includes("PLAN REQUIRED"),
        ),
      ),
    ).toBe(true);
    expect(
      captured.some((request) =>
        request.messages.some(
          (message) =>
            message.role === "system" &&
            message.content.includes("PLAN IN PROGRESS"),
        ),
      ),
    ).toBe(true);
    expect(result.continuation?.plan?.items[0]?.content).toBe(
      "Improve FWS notes",
    );
  });

  test("refuses text-only bailout after read budget until propose-write runs", async () => {
    const captured: StreamChatRequest[] = [];
    const changes = new InMemoryChangeSetStore();
    const provider: AiProvider = {
      async *streamChat(request, _signal) {
        captured.push(request);
        if (captured.length === 1) {
          yield {
            type: "tool-calls",
            calls: Array.from({ length: 8 }, (_, index) => ({
              id: `read-${index + 1}`,
              name: "read_note",
              arguments: {},
            })),
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        if (captured.length <= 3) {
          yield { type: "text-delta", delta: "Here is my plan only." };
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        yield {
          type: "tool-calls",
          calls: [
            {
              id: "propose-late",
              name: "propose",
              arguments: {},
            },
          ],
        };
        yield { type: "completed", finishReason: "tool_calls" };
      },
      testConnection: async () => undefined,
      listModels: async () => [],
      modelAvailable: async () => true,
      contextWindow: async () => null,
    };
    const registry = new ToolRegistry();
    registry.register(new ContentReadTool());
    registry.register(new ProposeTool(changes));
    const runner = new AgentRunner(provider, registry, changes);

    const result = await runner.run(
      {
        chatId: "chat-1",
        runId: "run-bailout",
        messages: [{ role: "user", content: "Reorganize notebooks" }],
        hasFileWorkspace: false,
        vault: false,
        readOnly: false,
        readableNoteIds: new Set<string>(),
        secretNotebookIds: new Set<string>(),
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("awaiting-approval");
    expect(captured.length).toBe(4);
    expect(
      captured.filter((request) =>
        request.messages.some(
          (message) =>
            message.role === "system" &&
            message.content.includes("PROPOSE REQUIRED"),
        ),
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  test("stops text-only bailouts early instead of burning the step budget", async () => {
    const captured: StreamChatRequest[] = [];
    const changes = new InMemoryChangeSetStore();
    const provider: AiProvider = {
      async *streamChat(request, _signal) {
        captured.push(request);
        if (captured.length === 1) {
          yield {
            type: "tool-calls",
            calls: Array.from({ length: 8 }, (_, index) => ({
              id: `read-${index + 1}`,
              name: "read_note",
              arguments: {},
            })),
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text-delta", delta: "Final plan without tools." };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => undefined,
      listModels: async () => [],
      modelAvailable: async () => true,
      contextWindow: async () => null,
    };
    const registry = new ToolRegistry();
    registry.register(new ContentReadTool());
    registry.register(new ProposeTool(changes));
    const runner = new AgentRunner(provider, registry, changes);

    const result = await runner.run(
      {
        chatId: "chat-1",
        runId: "run-no-bailout",
        messages: [{ role: "user", content: "Reorganize notebooks" }],
        hasFileWorkspace: false,
        vault: false,
        readOnly: false,
        readableNoteIds: new Set<string>(),
        secretNotebookIds: new Set<string>(),
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    expect(result.changeSet).toBeNull();
    expect(captured.length).toBe(6);
    expect(result.assistantText).toContain("BAILOUT EXHAUSTED");
  });

  test("blocks further inventory tools after significant discovery", async () => {
    const captured: StreamChatRequest[] = [];
    const changes = new InMemoryChangeSetStore();
    const provider: AiProvider = {
      async *streamChat(request, _signal) {
        captured.push(request);
        if (captured.length === 1) {
          yield {
            type: "tool-calls",
            calls: [
              { id: "nb", name: "list_notebooks", arguments: {} },
              {
                id: "notes-1",
                name: "list_notebook_notes",
                arguments: { notebook_id: "nb-1" },
              },
              {
                id: "notes-2",
                name: "list_notebook_notes",
                arguments: { notebook_id: "nb-2" },
              },
            ],
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        if (captured.length === 2) {
          yield {
            type: "tool-calls",
            calls: [
              {
                id: "plan-1",
                name: "set_agent_plan",
                arguments: {
                  items: [{ id: "1", content: "Improve notes" }],
                },
              },
            ],
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield {
          type: "tool-calls",
          calls: [{ id: "propose-1", name: "propose", arguments: {} }],
        };
        yield { type: "completed", finishReason: "tool_calls" };
      },
      testConnection: async () => undefined,
      listModels: async () => [],
      modelAvailable: async () => true,
      contextWindow: async () => null,
    };
    const registry = new ToolRegistry();
    registry.register(new ListTool());
    registry.register(new ListNotebookNotesTool());
    registerAgentPlanTools(registry);
    registry.register(new ProposeTool(changes));
    const runner = new AgentRunner(provider, registry, changes);

    await runner.run(
      {
        chatId: "chat-1",
        runId: "run-block-discovery",
        messages: [{ role: "user", content: "Improve all notes" }],
        hasFileWorkspace: false,
        vault: false,
        readOnly: false,
        readableNoteIds: new Set<string>(),
        secretNotebookIds: new Set<string>(),
      },
      new AbortController().signal,
    );

    expect(captured.length).toBeGreaterThanOrEqual(2);
    const secondTools = captured[1]?.tools.map((tool) => tool.name) ?? [];
    expect(secondTools).toContain("set_agent_plan");
    expect(secondTools).not.toContain("list_notebooks");
    expect(secondTools).not.toContain("list_notebook_notes");
    expect(
      captured.some((request) =>
        request.messages.some(
          (message) =>
            message.role === "system" &&
            message.content.includes("PLAN REQUIRED"),
        ),
      ),
    ).toBe(true);
  });

  test("bootstraps a plan after inventory when the model keeps narrating", async () => {
    const captured: StreamChatRequest[] = [];
    const changes = new InMemoryChangeSetStore();
    const plans: string[] = [];
    const provider: AiProvider = {
      async *streamChat(request, _signal) {
        captured.push(request);
        if (captured.length === 1) {
          yield {
            type: "tool-calls",
            calls: [
              { id: "nb", name: "list_notebooks", arguments: {} },
              {
                id: "notes-1",
                name: "list_notebook_notes",
                arguments: { notebook_id: "nb-1" },
              },
              {
                id: "notes-2",
                name: "list_notebook_notes",
                arguments: { notebook_id: "nb-2" },
              },
            ],
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        if (captured.length <= 3) {
          yield {
            type: "text-delta",
            delta: `Narrating inventory pass ${captured.length}.`,
          };
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        yield {
          type: "tool-calls",
          calls: [{ id: "propose-1", name: "propose", arguments: {} }],
        };
        yield { type: "completed", finishReason: "tool_calls" };
      },
      testConnection: async () => undefined,
      listModels: async () => [],
      modelAvailable: async () => true,
      contextWindow: async () => null,
    };
    const registry = new ToolRegistry();
    registry.register(new ListTool());
    registry.register(new ListNotebookNotesTool());
    registerAgentPlanTools(registry);
    registry.register(new ProposeTool(changes));
    const runner = new AgentRunner(provider, registry, changes, {
      onPlanUpdated(plan) {
        plans.push(plan.items.map((item) => item.content).join("|"));
      },
    });

    const result = await runner.run(
      {
        chatId: "chat-1",
        runId: "run-bootstrap-plan",
        messages: [{ role: "user", content: "Improve all notes" }],
        hasFileWorkspace: false,
        vault: false,
        readOnly: false,
        readableNoteIds: new Set<string>(),
        secretNotebookIds: new Set<string>(),
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("awaiting-approval");
    expect(plans.length).toBeGreaterThanOrEqual(1);
    expect(plans[0]).toContain("RF");
    expect(
      captured.some((request) =>
        request.messages.some(
          (message) =>
            message.role === "system" &&
            message.content.includes("PLAN BOOTSTRAPPED"),
        ),
      ),
    ).toBe(true);
    expect(result.assistantText).not.toContain("BAILOUT EXHAUSTED");
  });

  test("caps discovery tools in one batch and then requires a plan", async () => {
    const captured: StreamChatRequest[] = [];
    const changes = new InMemoryChangeSetStore();
    const provider: AiProvider = {
      async *streamChat(request, _signal) {
        captured.push(request);
        if (captured.length === 1) {
          yield {
            type: "tool-calls",
            calls: [
              { id: "nb", name: "list_notebooks", arguments: {} },
              ...Array.from({ length: 15 }, (_, index) => ({
                id: `notes-${index + 1}`,
                name: "list_notebook_notes",
                arguments: { notebook_id: `nb-${(index % 2) + 1}` },
              })),
            ],
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield {
          type: "tool-calls",
          calls: [
            {
              id: "plan-1",
              name: "set_agent_plan",
              arguments: {
                items: [{ id: "1", content: "Improve notes" }],
              },
            },
            { id: "propose-1", name: "propose", arguments: {} },
          ],
        };
        yield { type: "completed", finishReason: "tool_calls" };
      },
      testConnection: async () => undefined,
      listModels: async () => [],
      modelAvailable: async () => true,
      contextWindow: async () => null,
    };
    const registry = new ToolRegistry();
    registry.register(new ListTool());
    registry.register(new ListNotebookNotesTool());
    registerAgentPlanTools(registry);
    registry.register(new ProposeTool(changes));
    const runner = new AgentRunner(provider, registry, changes);

    const result = await runner.run(
      {
        chatId: "chat-1",
        runId: "run-cap-discovery",
        messages: [{ role: "user", content: "Improve all notes" }],
        hasFileWorkspace: false,
        vault: false,
        readOnly: false,
        readableNoteIds: new Set<string>(),
        secretNotebookIds: new Set<string>(),
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("awaiting-approval");
    const capped = result.messages.filter(
      (message) =>
        message.role === "tool" &&
        message.content.includes("per-segment cap"),
    );
    expect(capped.length).toBeGreaterThanOrEqual(1);
    expect(captured[1]?.tools.map((tool) => tool.name)).not.toContain(
      "list_notebook_notes",
    );
  });

  test("terminates varied text-only narration under an active plan", async () => {
    const captured: StreamChatRequest[] = [];
    const changes = new InMemoryChangeSetStore();
    const narrations = [
      "Now let me propose improvements for batch 2 notes.",
      "Let me propose the remaining batch 2 edits now.",
      "I'll call propose-write tools for the next notes next.",
    ];
    const provider: AiProvider = {
      async *streamChat(request, _signal) {
        captured.push(request);
        if (captured.length === 1) {
          yield {
            type: "tool-calls",
            calls: [
              {
                id: "plan-1",
                name: "set_agent_plan",
                arguments: {
                  items: [
                    { id: "1", content: "Improve batch 1", status: "completed" },
                    { id: "2", content: "Improve batch 2" },
                  ],
                },
              },
            ],
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        const text = narrations[captured.length - 2] ?? "Still narrating only.";
        yield { type: "text-delta", delta: text };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => undefined,
      listModels: async () => [],
      modelAvailable: async () => true,
      contextWindow: async () => null,
    };
    const registry = new ToolRegistry();
    registerAgentPlanTools(registry);
    registry.register(new ProposeTool(changes));
    const runner = new AgentRunner(provider, registry, changes);

    const result = await runner.run(
      {
        chatId: "chat-1",
        runId: "run-varied-narration",
        messages: [{ role: "user", content: "Improve all notes" }],
        hasFileWorkspace: false,
        vault: false,
        readOnly: false,
        readableNoteIds: new Set<string>(),
        secretNotebookIds: new Set<string>(),
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    expect(captured.length).toBe(4);
    expect(result.assistantText).toContain("STUCK LOOP DETECTED");
  });

  test("recovers to propose-write after one text-only plan bailout", async () => {
    const captured: StreamChatRequest[] = [];
    const changes = new InMemoryChangeSetStore();
    const provider: AiProvider = {
      async *streamChat(request, _signal) {
        captured.push(request);
        if (captured.length === 1) {
          yield {
            type: "tool-calls",
            calls: [
              {
                id: "plan-1",
                name: "set_agent_plan",
                arguments: {
                  items: [{ id: "1", content: "Improve notes" }],
                },
              },
            ],
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        if (captured.length === 2) {
          yield {
            type: "text-delta",
            delta: "Plan ready. I'll propose edits next.",
          };
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        yield {
          type: "tool-calls",
          calls: [{ id: "propose-1", name: "propose", arguments: {} }],
        };
        yield { type: "completed", finishReason: "tool_calls" };
      },
      testConnection: async () => undefined,
      listModels: async () => [],
      modelAvailable: async () => true,
      contextWindow: async () => null,
    };
    const registry = new ToolRegistry();
    registerAgentPlanTools(registry);
    registry.register(new ProposeTool(changes));
    const runner = new AgentRunner(provider, registry, changes);

    const result = await runner.run(
      {
        chatId: "chat-1",
        runId: "run-recover-propose",
        messages: [{ role: "user", content: "Improve notes" }],
        hasFileWorkspace: false,
        vault: false,
        readOnly: false,
        readableNoteIds: new Set<string>(),
        secretNotebookIds: new Set<string>(),
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("awaiting-approval");
    expect(captured.length).toBe(3);
    expect(result.changeSet).not.toBeNull();
  });

  test("stores the agent plan on continuation after a propose-write pause", async () => {
    const changes = new InMemoryChangeSetStore();
    const provider: AiProvider = {
      async *streamChat(_request, _signal) {
        yield {
          type: "tool-calls",
          calls: [
            {
              id: "plan-1",
              name: "set_agent_plan",
              arguments: {
                items: [{ id: "1", content: "Improve FWS notes" }],
              },
            },
            {
              id: "propose-1",
              name: "propose",
              arguments: {},
            },
          ],
        };
        yield { type: "completed", finishReason: "tool_calls" };
      },
      testConnection: async () => undefined,
      listModels: async () => [],
      modelAvailable: async () => true,
      contextWindow: async () => null,
    };
    const registry = new ToolRegistry();
    registerAgentPlanTools(registry);
    registry.register(new ProposeTool(changes));
    const plans: unknown[] = [];
    const runner = new AgentRunner(provider, registry, changes, {
      onPlanUpdated: (plan) => plans.push(plan),
    });

    const result = await runner.run(
      {
        chatId: "chat-1",
        runId: "run-plan",
        messages: [{ role: "user", content: "Improve all notes" }],
        hasFileWorkspace: false,
        vault: false,
        readOnly: false,
        readableNoteIds: new Set<string>(),
        secretNotebookIds: new Set<string>(),
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("awaiting-approval");
    expect(result.continuation?.plan?.items).toEqual([
      { id: "1", content: "Improve FWS notes", status: "pending" },
    ]);
    expect(plans).toHaveLength(1);
  });
});

class InvalidThenRecoverProvider implements AiProvider {
  public callCount = 0;

  public async *streamChat(): AsyncIterable<ProviderEvent> {
    this.callCount += 1;
    if (this.callCount === 1) {
      yield {
        type: "tool-calls",
        calls: [
          {
            id: "bad-move",
            name: "strict_move",
            arguments: {
              note_id: "note-1",
              expected_updated_time: 10,
            },
          },
        ],
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text-delta", delta: "Recovered after bad tool args." };
    yield { type: "completed", finishReason: "stop" };
  }

  public async testConnection(): Promise<void> {
    return Promise.resolve();
  }

  public async listModels(): Promise<readonly string[]> {
    return [];
  }

  public async modelAvailable(): Promise<boolean> {
    return true;
  }

  public async contextWindow(): Promise<number | null> {
    return null;
  }
}

class StrictMoveTool implements AgentTool<
  { note_id: string; expected_updated_time: number; parent_id: string },
  { ok: boolean }
> {
  public readonly name = "strict_move";
  public readonly description = "Require destination notebook";
  public readonly risk = "propose-write" as const;
  public readonly inputSchema = Type.Object(
    {
      note_id: Type.String({ minLength: 1 }),
      expected_updated_time: Type.Number({ minimum: 0 }),
      parent_id: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object({ ok: Type.Boolean() });

  public isAvailable(): boolean {
    return true;
  }

  public async execute(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}

describe("AgentRunner stuck loop detection", () => {
  test("terminates when assistant text repeats across tool steps under a plan", async () => {
    const captured: StreamChatRequest[] = [];
    const repeatedText = "Propose X and read remaining notes for the plan";
    const changes = new InMemoryChangeSetStore();
    const provider: AiProvider = {
      async *streamChat(request, _signal) {
        captured.push(request);
        if (captured.length === 1) {
          yield {
            type: "tool-calls",
            calls: [
              {
                id: "plan-1",
                name: "set_agent_plan",
                arguments: {
                  items: [{ id: "1", content: "Improve notes" }],
                },
              },
            ],
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text-delta", delta: repeatedText };
        yield {
          type: "tool-calls",
          calls: [
            {
              id: `echo-${captured.length}`,
              name: "echo",
              arguments: {},
            },
          ],
        };
        yield { type: "completed", finishReason: "tool_calls" };
      },
      testConnection: async () => undefined,
      listModels: async () => [],
      modelAvailable: async () => true,
      contextWindow: async () => null,
    };
    const registry = new ToolRegistry();
    registerAgentPlanTools(registry);
    registry.register(new EchoTool());
    const runner = new AgentRunner(provider, registry, changes);

    const result = await runner.run(
      {
        chatId: "chat-1",
        runId: "run-stuck",
        messages: [{ role: "user", content: "Improve all my notes" }],
        hasFileWorkspace: false,
        vault: false,
        readOnly: false,
        readableNoteIds: new Set<string>(),
        secretNotebookIds: new Set<string>(),
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    expect(captured.length).toBe(4);
    expect(result.assistantText).toContain("STUCK LOOP DETECTED");
  });
});
