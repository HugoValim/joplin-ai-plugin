import { Type } from "@sinclair/typebox";
import type {
  AiProvider,
  ProviderEvent,
  StreamChatRequest,
} from "../../src/providers/types";
import { InMemoryChangeSetStore } from "../../src/persistence/changeSetStore";
import { AgentRunner } from "../../src/agent/agentRunner";
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
  test("stops after twenty-four model steps", async () => {
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
          hasFileWorkspace: false,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("24 model steps");
    expect(provider.callCount).toBe(24);
  });

  test("stops when parallel tool batches exceed one hundred calls", async () => {
    const provider = new RepeatingToolProvider(10);
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
          messages: [{ role: "user", content: "Many tools" }],
          hasFileWorkspace: false,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("expected at most 100");
    expect(provider.callCount).toBe(11);
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
        hasFileWorkspace: true,
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
          hasFileWorkspace: false,
        },
        controller.signal,
      ),
    ).rejects.toThrow("Agent run cancelled");
    expect(provider.callCount).toBe(0);
  });
});
