import type {
  AiProvider,
  ProviderEvent,
  StreamChatRequest,
} from "../../src/providers/types";
import { Type } from "@sinclair/typebox";
import { InMemoryChangeSetStore } from "../../src/persistence/changeSetStore";
import {
  AgentRunner,
  type AgentRunRequest,
} from "../../src/agent/agentRunner";
import { registerSubAgentTools } from "../../src/tools/subAgentTools";
import { registerAgentPlanTools } from "../../src/tools/agentPlanTools";
import {
  ToolRegistry,
  type AgentTool,
  type ToolExecutionContext,
} from "../../src/tools/toolRegistry";

function baseRequest(
  overrides: Partial<AgentRunRequest> = {},
): AgentRunRequest {
  return {
    chatId: "chat-1",
    runId: "run-1",
    messages: [{ role: "user", content: "Heavy plan" }],
    hasFileWorkspace: false,
    vault: false,
    readOnly: false,
    readableNoteIds: new Set(),
    secretNotebookIds: new Set(),
    ...overrides,
  };
}

describe("AgentRunner nested subagents", () => {
  test("start_subagent runs a nested read-only helper and returns its text", async () => {
    let parentStep = 0;
    const provider: AiProvider = {
      async *streamChat(
        request: StreamChatRequest,
      ): AsyncIterable<ProviderEvent> {
        const isSub =
          request.messages.some(
            (message) =>
              message.role === "system" &&
              typeof message.content === "string" &&
              message.content.includes("read-only helper subagent"),
          ) ||
          request.messages.some(
            (message) =>
              message.role === "user" &&
              message.content === "Summarize notebook A",
          );
        if (isSub && !request.messages.some((m) => m.role === "assistant")) {
          yield { type: "text-delta", delta: "Notebook A has 3 notes." };
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        parentStep += 1;
        if (parentStep === 1) {
          yield {
            type: "tool-calls",
            calls: [
              {
                id: "spawn-1",
                name: "start_subagent",
                arguments: {
                  subagent_id: "sub-a",
                  task: "Summarize notebook A",
                },
              },
            ],
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text-delta", delta: "Merged subagent findings." };
        yield { type: "completed", finishReason: "stop" };
      },
      async testConnection(): Promise<void> {},
      async listModels(): Promise<readonly string[]> {
        return [];
      },
      async modelAvailable(): Promise<boolean> {
        return true;
      },
      contextWindow: async () => null,
    };
    const tools = new ToolRegistry();
    registerSubAgentTools(tools);
    const progress: string[] = [];
    const runner = new AgentRunner(
      provider,
      tools,
      new InMemoryChangeSetStore(),
      {
        onStep: (_c, _t, label): void => {
          if (label) progress.push(label);
        },
      },
    );

    const outcome = await runner.run(baseRequest(), new AbortController().signal);
    expect(outcome.status).toBe("completed");
    expect(outcome.assistantText).toContain("Merged subagent findings.");
    const spawnResult = outcome.messages.find(
      (message) => message.role === "tool" && message.toolCallId === "spawn-1",
    );
    expect(spawnResult?.content).toContain("Notebook A has 3 notes.");
    expect(progress.some((label) => label.includes("Subagent sub-a"))).toBe(
      true,
    );
  });

  test("refuses a fourth concurrent start_subagent", async () => {
    const started = new Set<string>();
    const provider: AiProvider = {
      async *streamChat(
        request: StreamChatRequest,
      ): AsyncIterable<ProviderEvent> {
        const task = request.messages.find((m) => m.role === "user")?.content;
        if (
          typeof task === "string" &&
          task.startsWith("task-") &&
          request.messages.some(
            (m) =>
              m.role === "system" &&
              typeof m.content === "string" &&
              m.content.includes("read-only helper"),
          )
        ) {
          const id = task;
          started.add(id);
          // Hold until parent refuses the 4th or we finish all first three.
          await new Promise((resolve) => setTimeout(resolve, 40));
          yield { type: "text-delta", delta: `done ${id}` };
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        if (!request.messages.some((m) => m.role === "assistant")) {
          yield {
            type: "tool-calls",
            calls: [1, 2, 3, 4].map((n) => ({
              id: `spawn-${n}`,
              name: "start_subagent",
              arguments: {
                subagent_id: `sub-${n}`,
                task: `task-${n}`,
              },
            })),
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text-delta", delta: "done" };
        yield { type: "completed", finishReason: "stop" };
      },
      async testConnection(): Promise<void> {},
      async listModels(): Promise<readonly string[]> {
        return [];
      },
      async modelAvailable(): Promise<boolean> {
        return true;
      },
      contextWindow: async () => null,
    };
    const tools = new ToolRegistry();
    registerSubAgentTools(tools);
    const runner = new AgentRunner(
      provider,
      tools,
      new InMemoryChangeSetStore(),
    );
    const outcome = await runner.run(baseRequest(), new AbortController().signal);
    const toolMessages = outcome.messages.filter((m) => m.role === "tool");
    const refused = toolMessages.find((m) =>
      m.content.includes('"status":"refused"'),
    );
    expect(refused).toBeDefined();
    expect(started.size).toBe(3);
  });

  test("parent cancel aborts an in-flight subagent", async () => {
    const parentAbort = new AbortController();
    let subAborted = false;
    const provider: AiProvider = {
      async *streamChat(
        request: StreamChatRequest,
        signal: AbortSignal,
      ): AsyncIterable<ProviderEvent> {
        const isSub = request.messages.some(
          (m) =>
            m.role === "system" &&
            typeof m.content === "string" &&
            m.content.includes("read-only helper"),
        );
        if (isSub) {
          signal.addEventListener("abort", () => {
            subAborted = true;
          });
          parentAbort.abort(new Error("cancel parent"));
          await new Promise((resolve) => setTimeout(resolve, 30));
          if (signal.aborted) {
            throw Object.assign(new Error("aborted"), { name: "AbortError" });
          }
          yield { type: "text-delta", delta: "should not finish" };
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        if (!request.messages.some((m) => m.role === "assistant")) {
          yield {
            type: "tool-calls",
            calls: [
              {
                id: "spawn-1",
                name: "start_subagent",
                arguments: { subagent_id: "sub-1", task: "long task" },
              },
            ],
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text-delta", delta: "parent done" };
        yield { type: "completed", finishReason: "stop" };
      },
      async testConnection(): Promise<void> {},
      async listModels(): Promise<readonly string[]> {
        return [];
      },
      async modelAvailable(): Promise<boolean> {
        return true;
      },
      contextWindow: async () => null,
    };
    const tools = new ToolRegistry();
    registerSubAgentTools(tools);
    const runner = new AgentRunner(
      provider,
      tools,
      new InMemoryChangeSetStore(),
    );

    await expect(
      runner.run(baseRequest(), parentAbort.signal),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(subAborted).toBe(true);
  });

  test("fans out all start_subagent calls in one turn like Cursor multi-agents", async () => {
    const live = new Set<string>();
    let maxLive = 0;
    let parentStep = 0;
    const provider: AiProvider = {
      async *streamChat(
        request: StreamChatRequest,
      ): AsyncIterable<ProviderEvent> {
        const isSub = request.messages.some(
          (m) =>
            m.role === "system" &&
            typeof m.content === "string" &&
            m.content.includes("helper subagent"),
        );
        if (isSub) {
          const task = String(
            request.messages.find((m) => m.role === "user")?.content ?? "",
          );
          live.add(task);
          maxLive = Math.max(maxLive, live.size);
          await new Promise((resolve) => setTimeout(resolve, 30));
          live.delete(task);
          // Helpers must only see read tools — never start_subagent / plan meta.
          expect(
            (request.tools ?? []).every((tool) => !tool.name.includes("subagent")),
          ).toBe(true);
          expect(
            (request.tools ?? []).every((tool) => tool.name !== "set_agent_plan"),
          ).toBe(true);
          yield { type: "text-delta", delta: `done:${task}` };
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        parentStep += 1;
        if (parentStep === 1) {
          yield {
            type: "tool-calls",
            calls: [
              {
                id: "spawn-a",
                name: "start_subagent",
                arguments: { subagent_id: "a", task: "scope-a" },
              },
              {
                id: "echo-mid",
                name: "echo",
                arguments: {},
              },
              {
                id: "spawn-b",
                name: "start_subagent",
                arguments: { subagent_id: "b", task: "scope-b" },
              },
            ],
          };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield { type: "text-delta", delta: "merged" };
        yield { type: "completed", finishReason: "stop" };
      },
      async testConnection(): Promise<void> {},
      async listModels(): Promise<readonly string[]> {
        return [];
      },
      async modelAvailable(): Promise<boolean> {
        return true;
      },
      contextWindow: async () => null,
    };
    const tools = new ToolRegistry();
    registerSubAgentTools(tools);
    registerAgentPlanTools(tools);
    tools.register(new EchoReadTool());
    const runner = new AgentRunner(
      provider,
      tools,
      new InMemoryChangeSetStore(),
    );
    const outcome = await runner.run(baseRequest(), new AbortController().signal);
    expect(outcome.status).toBe("completed");
    expect(maxLive).toBe(2);
    const toolContents = outcome.messages
      .filter((m) => m.role === "tool")
      .map((m) => m.content);
    expect(toolContents.some((c) => c.includes("done:scope-a"))).toBe(true);
    expect(toolContents.some((c) => c.includes("done:scope-b"))).toBe(true);
  });
});

class EchoReadTool implements AgentTool<Record<string, never>, { ok: boolean }> {
  public readonly name = "echo";
  public readonly description = "noop";
  public readonly risk = "read" as const;
  public readonly inputSchema = Type.Object(
    {},
    { additionalProperties: false },
  );
  public readonly outputSchema = Type.Object({ ok: Type.Boolean() });

  public isAvailable(_context: ToolExecutionContext): boolean {
    return true;
  }

  public async execute(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}
