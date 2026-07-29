import type {
  AiProvider,
  NormalizedToolCall,
} from "../providers/types";
import type { ChangeSetStore } from "../persistence/changeSetStore";
import { DomainError } from "../shared/errors";
import type {
  AgentObserver,
  AgentRunRequest,
} from "./agentRunner";
import type { SubAgentRegistry } from "./subAgentRegistry";
import type { ToolRegistry } from "../tools/toolRegistry";
import type {
  SubAgentSpawnInput,
  SubAgentSpawnResult,
} from "../tools/toolRegistry";

/** Nested helpers stay short; parent merges and proposes writes. */
export const SUBAGENT_MAX_MODEL_STEPS = 24;

export const SUBAGENT_SYSTEM_PROMPT = [
  "You are a read-only helper subagent.",
  "Use available read tools to gather facts for the parent agent.",
  "Do not propose note or file writes; summarize findings in your final text reply.",
  "Stay within the given task; do not spawn further subagents.",
].join(" ");

export interface NestedAgentRunnerFactory {
  create(
    observer: AgentObserver,
  ): {
    run(
      request: AgentRunRequest,
      abortSignal: AbortSignal,
    ): Promise<{ readonly assistantText: string }>;
  };
}

/**
 * Owns concurrency + abort wiring for nested read-only subagent runs.
 *
 * @example const host = new SubAgentHost(registry, factory, observer)
 */
export class SubAgentHost {
  public constructor(
    private readonly registry: SubAgentRegistry,
    private readonly createNested: NestedAgentRunnerFactory,
    private readonly observer: AgentObserver,
  ) {}

  /**
   * Starts a capped nested run and returns its findings to the parent tool call.
   *
   * @example await host.run({ subagent_id: "a", task: "Summarize" }, parent, signal)
   */
  public async run(
    input: SubAgentSpawnInput,
    parentRequest: AgentRunRequest,
    parentAbort: AbortSignal,
  ): Promise<SubAgentSpawnResult> {
    const controller = new AbortController();
    if (!this.registry.tryStart(input.subagent_id, controller)) {
      return refusedSpawn(input.subagent_id, this.registry);
    }
    const onParentAbort = (): void => {
      controller.abort(
        parentAbort.reason ??
          new Error("Parent run cancelled; aborting subagents"),
      );
    };
    parentAbort.addEventListener("abort", onParentAbort);
    if (parentAbort.aborted) onParentAbort();
    let outcomeStatus: SubAgentSpawnResult["status"] = "failed";
    let outcomeMessage = `Subagent ${input.subagent_id} failed`;
    let resultText = "";
    try {
      const nested = this.createNested.create(
        nestedObserver(this.observer, input.subagent_id),
      );
      const outcome = await nested.run(
        {
          chatId: parentRequest.chatId,
          runId: `${parentRequest.runId}:sub:${input.subagent_id}`,
          messages: [
            { role: "system", content: SUBAGENT_SYSTEM_PROMPT },
            { role: "user", content: input.task },
          ],
          hasFileWorkspace: parentRequest.hasFileWorkspace,
          vault: parentRequest.vault,
          readOnly: true,
          readableNoteIds: parentRequest.readableNoteIds,
          secretNotebookIds: parentRequest.secretNotebookIds,
          maxModelSteps: SUBAGENT_MAX_MODEL_STEPS,
        },
        controller.signal,
      );
      outcomeStatus = "completed";
      outcomeMessage = `Subagent ${input.subagent_id} finished`;
      resultText = outcome.assistantText.slice(0, 8_000);
    } catch (error: unknown) {
      if (controller.signal.aborted || isAbortError(error)) {
        outcomeStatus = "cancelled";
        outcomeMessage = `Subagent ${input.subagent_id} cancelled`;
      } else {
        const detail =
          error instanceof Error ? error.message : "Unexpected subagent failure";
        outcomeMessage =
          `Subagent ${input.subagent_id} failed: ${detail}`.slice(0, 500);
      }
    } finally {
      parentAbort.removeEventListener("abort", onParentAbort);
      this.registry.complete(input.subagent_id);
    }
    return {
      subagent_id: input.subagent_id,
      status: outcomeStatus,
      message: outcomeMessage,
      result_text: resultText,
      active_count: this.registry.activeCount,
    };
  }

  public abort(subAgentId: string): number {
    this.registry.abort(subAgentId);
    return this.registry.activeCount;
  }

  public cancelAll(): void {
    this.registry.cancelAll();
  }
}

/**
 * Builds a NestedAgentRunnerFactory that shares parent provider/tools/changes.
 *
 * @example createNestedRunnerFactory(provider, tools, changes, AgentRunner)
 */
export function createNestedRunnerFactory(
  provider: AiProvider,
  tools: ToolRegistry,
  changes: ChangeSetStore,
  Runner: new (
    provider: AiProvider,
    tools: ToolRegistry,
    changes: ChangeSetStore,
    observer?: AgentObserver,
  ) => {
    run(
      request: AgentRunRequest,
      abortSignal: AbortSignal,
    ): Promise<{ readonly assistantText: string }>;
  },
): NestedAgentRunnerFactory {
  return {
    create: (observer) => new Runner(provider, tools, changes, observer),
  };
}

function refusedSpawn(
  subAgentId: string,
  registry: SubAgentRegistry,
): SubAgentSpawnResult {
  return {
    subagent_id: subAgentId,
    status: "refused",
    message: registry.has(subAgentId)
      ? `Subagent ${subAgentId} is already running`
      : `Concurrency cap reached; ${registry.activeCount} of 3 subagents active. Complete one before spawning another.`,
    result_text: "",
    active_count: registry.activeCount,
  };
}

function nestedObserver(
  parent: AgentObserver,
  subAgentId: string,
): AgentObserver {
  return {
    onToolStarted: (call: NormalizedToolCall): void => {
      parent.onToolStarted?.({
        ...call,
        name: `subagent[${subAgentId}].${call.name}`,
      });
    },
    onToolCompleted: (result): void => {
      parent.onToolCompleted?.({
        ...result,
        name: `subagent[${subAgentId}].${result.name}`,
      });
    },
    onStep: (current, total): void => {
      parent.onStep?.(
        current,
        total,
        `Subagent ${subAgentId}: step ${current} of ${total}`,
      );
    },
  };
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DomainError && error.code === "ABORTED") ||
    (error instanceof Error && error.name === "AbortError")
  );
}
