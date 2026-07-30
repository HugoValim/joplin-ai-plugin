import { randomUUID } from "crypto";
import path from "path";
import {
  AgentRunner,
  type AgentObserver,
  type TokenUsage,
} from "../agent/agentRunner";
import type { ChangeApplier } from "../agent/changeApplier";
import type { ContextBuilder } from "../agent/contextBuilder";
import type { ChangeSet, ChangeSetStore } from "../persistence/changeSetStore";
import type {
  ChatStore,
  PersistedChat,
  PersistedChatMessage,
  PersistedRunSummary,
} from "../persistence/chatStore";
import { DomainError, safeValue } from "../shared/errors";
import type { PanelRequest } from "../shared/protocol";
import { isSafeExternalMarkdownUrl } from "../shared/safeExternalUrl";
import { searchMentionHits, type MentionSearchPort } from "./mentionSearch";
import type { ToolRegistry, ToolExecutionResult } from "../tools/toolRegistry";
import { loadSystemPrompt, type SettingsPort } from "./settings";
import type { PanelPort } from "./panelPort";
import type { PerChatWorkspaceResolver } from "./workspaceAdapters";
import { DeltaBatcher } from "./deltaBatcher";
import { mergeHistory, toActiveChat } from "./chatView";
import {
  deleteChatAndChooseNext,
  lastUserMessage,
  persistRunOutcome,
  requireChat,
  truncateForRegenerate,
} from "./chatLifecycle";
import { ProviderConnector, type EndpointStatus } from "./providerConnector";
import { RunCancellationRegistry } from "./runCancellationRegistry";
import { PRIVACY_NOTICE } from "./privacy";
import { PluginEventSender } from "./pluginEventSender";
import type { AssistantOutputActions } from "./assistantOutputActions";
import type { CommandPort, DialogPort, ProviderFactory } from "./types";
import { summarizeToolResult } from "./toolActivity";
import { ApprovalWorkflow } from "./approvalWorkflow";
import type { SecretNotebookStore } from "../persistence/secretNotebookStore";
import { NoOpReviewNotePort, type ReviewNotePort } from "./reviewNoteService";

const AUTO_APPLY_WARNING =
  "Security warning: Bypass permissions will auto-apply every model-proposed non-delete change, then keep an inline Keep/Undo review in the sidebar. Deletions still require manual ChangeReview before apply. Conflicts are still blocked. Enable for this chat?";

export class ChatController {
  private activeChatId: string | null = null;
  private endpointStatus: EndpointStatus = "unconfigured";
  private modelName = "";
  private availableModels: readonly string[] = [];
  private contextWindowMax: number | null = null;
  private secretNotebookIds: ReadonlySet<string> = new Set();
  private readonly activeRuns = new RunCancellationRegistry();
  private readonly providerConnector: ProviderConnector;
  private readonly events: PluginEventSender;
  private readonly approvals: ApprovalWorkflow;

  public constructor(
    private readonly panel: PanelPort,
    private readonly chats: ChatStore,
    private readonly contextBuilder: ContextBuilder,
    private readonly tools: ToolRegistry,
    private readonly changes: ChangeSetStore,
    applier: ChangeApplier,
    private readonly workspaces: PerChatWorkspaceResolver,
    private readonly settings: SettingsPort,
    private readonly dialogs: DialogPort,
    private readonly commands: CommandPort,
    private readonly assistantActions: AssistantOutputActions,
    private readonly secretNotebooks: SecretNotebookStore,
    createProvider: ProviderFactory,
    reviewNotes: ReviewNotePort = new NoOpReviewNotePort(),
    private readonly mentionSearch: MentionSearchPort | null = null,
  ) {
    this.providerConnector = new ProviderConnector(
      settings,
      dialogs,
      createProvider,
    );
    this.events = new PluginEventSender(panel);
    this.approvals = new ApprovalWorkflow(
      chats,
      changes,
      applier,
      tools,
      this.providerConnector,
      this.events,
      this.activeRuns,
      reviewNotes,
    );
  }

  /**
   * Handles one validated sidebar request and emits state/run events.
   *
   * @example await controller.handle(panelRequest)
   */
  public async handle(request: PanelRequest): Promise<void> {
    switch (request.type) {
      case "panel.ready":
        await this.handleReady();
        return;
      case "chat.create":
        await this.createChat(request.payload.title);
        return;
      case "chat.select":
        await this.selectChat(request.chatId);
        return;
      case "chat.clear":
        this.activeRuns.cancelChat(request.chatId, "Chat cleared");
        this.approvals.abandonChat(request.chatId);
        await this.chats.clear(request.chatId);
        await this.sendSnapshot();
        return;
      case "chat.delete":
        this.activeRuns.cancelChat(request.chatId, "Chat deleted");
        this.approvals.abandonChat(request.chatId);
        await this.selectChat(
          await deleteChatAndChooseNext(
            this.chats,
            this.workspaces,
            request.chatId,
          ),
        );
        return;
      case "chat.rename":
        await this.renameChat(request);
        return;
      case "chat.submit":
        await this.submit(request);
        return;
      case "chat.retry":
        await this.retry(request);
        return;
      case "chat.regenerate":
        await this.regenerate(request);
        return;
      case "run.cancel":
        this.activeRuns.cancel(request.chatId, request.runId);
        return;
      case "context.update":
        await this.updateContext(request);
        return;
      case "context.search":
        await this.searchContext(request);
        return;
      case "folder.select":
        await this.selectFolder(request.chatId);
        return;
      case "changes.apply":
        await this.approvals.apply(request);
        await this.sendSnapshot();
        return;
      case "changes.discard":
        await this.approvals.discard(request);
        await this.sendSnapshot();
        return;
      case "changes.deny":
        await this.approvals.deny(request);
        await this.sendSnapshot();
        return;
      case "changes.keep":
        await this.approvals.keep(request);
        await this.sendSnapshot();
        return;
      case "changes.undo":
        await this.approvals.undoChanges(request);
        await this.sendSnapshot();
        return;
      case "review.open":
        await this.approvals.openReview(request);
        await this.sendSnapshot();
        return;
      case "run.undo":
        await this.approvals.undo(request);
        await this.sendSnapshot();
        return;
      case "note.open":
        await this.commands.execute("openNote", request.payload.noteId);
        return;
      case "link.open":
        if (!isSafeExternalMarkdownUrl(request.payload.url)) {
          throw new DomainError(
            "SECURITY",
            `expected an absolute http(s) URL, got ${safeValue(request.payload.url)}`,
          );
        }
        await this.commands.execute("openItem", request.payload.url);
        return;
      case "assistant.action":
        this.events.post(
          "run.completed",
          request.chatId,
          {
            summary: await this.assistantActions.execute(
              request.chatId,
              request.payload,
            ),
          },
          request.runId,
        );
        return;
      case "secrets.mark":
        this.secretNotebookIds = await this.secretNotebooks.mark(
          request.payload.notebookId,
        );
        await this.sendSnapshot();
        return;
      case "secrets.unmark":
        this.secretNotebookIds = await this.secretNotebooks.unmark(
          request.payload.notebookId,
        );
        await this.sendSnapshot();
        return;
      case "model.select":
        await this.selectModel(request.payload.model);
        return;
    }
  }

  /** Publishes active-note identity without its body. Example: workspaceChanged(note). */
  public workspaceChanged(
    activeNote: {
      readonly id: string;
      readonly title: string;
      readonly parentNotebookId: string;
    } | null,
  ): void {
    const chatId = this.activeChatId ?? "bootstrap";
    const summary = activeNote
      ? {
          id: activeNote.id,
          title: activeNote.title.trim().slice(0, 500) || "Untitled note",
          parentNotebookId: activeNote.parentNotebookId,
        }
      : null;
    this.events.post("workspace.changed", chatId, { activeNote: summary });
  }

  private async handleReady(): Promise<void> {
    this.secretNotebookIds = await this.secretNotebooks.list();
    const summaries = await this.chats.list();
    let selected: PersistedChat | null = null;
    for (const summary of summaries) {
      selected = await this.chats.get(summary.id);
      if (selected) break;
    }
    selected ??= await this.chats.create();
    await this.selectChat(selected.id);
    void this.checkEndpoint();
  }

  private async createChat(title?: string): Promise<void> {
    const chat = await this.chats.create(title);
    await this.selectChat(chat.id);
  }

  /**
   * Creates a new chat, selects it, and optionally prefills the composer.
   *
   * @example await controller.startNewChatWithSelection(selectedText)
   */
  public async startNewChatWithSelection(text: string): Promise<void> {
    await this.createChat();
    const chatId = this.activeChatId;
    if (!chatId || !text.trim()) return;
    this.events.post("composer.prefill", chatId, { text });
  }

  private async selectChat(chatId: string): Promise<void> {
    const chat = await requireChat(this.chats, chatId);
    this.activeChatId = chat.id;
    this.workspaces.setRoot(chat.id, chat.externalRoot);
    await this.sendSnapshot();
  }

  private async submit(
    request: Extract<PanelRequest, { type: "chat.submit" }>,
  ): Promise<void> {
    await this.startRun(
      request.chatId,
      request.runId,
      async (deltas, signal) => {
        const chat = await requireChat(this.chats, request.chatId);
        const saved = await this.appendUserMessage(chat, request.payload.text);
        await this.executeRunWithChat(
          request.chatId,
          request.runId,
          saved,
          request.payload.text,
          deltas,
          signal,
        );
      },
    );
  }

  private async retry(
    request: Extract<PanelRequest, { type: "chat.retry" }>,
  ): Promise<void> {
    await this.startRun(
      request.chatId,
      request.runId,
      async (deltas, signal) => {
        const chat = await requireChat(this.chats, request.chatId);
        const userMessage = lastUserMessage(chat);
        if (!userMessage) {
          throw new DomainError(
            "NOT_AVAILABLE",
            `Chat ${safeValue(chat.id)} has no user message to retry; expected at least one user turn`,
          );
        }
        await this.executeRunWithChat(
          request.chatId,
          request.runId,
          chat,
          userMessage.content,
          deltas,
          signal,
        );
      },
    );
  }

  private async regenerate(
    request: Extract<PanelRequest, { type: "chat.regenerate" }>,
  ): Promise<void> {
    await this.startRun(
      request.chatId,
      request.runId,
      async (deltas, signal) => {
        const chat = await requireChat(this.chats, request.chatId);
        const truncated = truncateForRegenerate(
          chat,
          request.payload.messageId,
        );
        await this.chats.save(truncated);
        const userMessage = lastUserMessage(truncated);
        if (!userMessage) {
          throw new DomainError(
            "NOT_AVAILABLE",
            `Chat ${safeValue(chat.id)} has no user message before regenerate target; expected a prior user turn`,
          );
        }
        await this.executeRunWithChat(
          request.chatId,
          request.runId,
          truncated,
          userMessage.content,
          deltas,
          signal,
        );
      },
    );
  }

  private async startRun(
    chatId: string,
    runId: string,
    execute: (deltas: DeltaBatcher, abortSignal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const abortController = new AbortController();
    if (!this.activeRuns.tryStart(chatId, runId, abortController)) {
      throw new DomainError(
        "CONFLICT",
        `Chat ${safeValue(chatId)} already has an active run; expected one run at a time`,
      );
    }
    this.events.post("run.started", chatId, { startedAt: Date.now() }, runId);
    const deltaBatcher = new DeltaBatcher((delta) => {
      this.events.post("assistant.delta", chatId, { delta }, runId);
    });
    try {
      await execute(deltaBatcher, abortController.signal);
    } catch (error: unknown) {
      deltaBatcher.flush();
      await this.recordFailure(chatId, runId, error);
    } finally {
      deltaBatcher.dispose();
      this.activeRuns.clearIfCurrent(chatId, abortController);
    }
  }

  private async executeRunWithChat(
    chatId: string,
    runId: string,
    chat: PersistedChat,
    userText: string,
    deltaBatcher: DeltaBatcher,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const session = await this.providerConnector.connectWithConfirmation();
    this.modelName = session.config.model;
    const context = await this.contextBuilder.build({
      systemPrompt: await loadSystemPrompt(this.settings),
      modelName: session.config.model,
      userText,
      settings: chat.context,
      hasFileWorkspace: Boolean(chat.externalRoot),
      secretNotebookIds: this.secretNotebookIds,
    });
    this.activeChatId = chat.id;
    await this.sendSnapshot();
    const runner = new AgentRunner(
      session.provider,
      this.tools,
      this.changes,
      this.observer({ chatId, runId }, deltaBatcher),
    );
    const outcome = await runner.run(
      {
        chatId: chat.id,
        runId,
        messages: mergeHistory(context.messages, chat.messages),
        hasFileWorkspace: Boolean(chat.externalRoot),
        vault: chat.context.vault,
        readOnly: chat.context.interactionMode === "ask",
        readableNoteIds: context.readableNoteIds,
        secretNotebookIds: this.secretNotebookIds,
      },
      abortSignal,
    );
    deltaBatcher.flush();
    this.markEndpointOnline();
    await persistRunOutcome(
      this.chats,
      chat,
      runId,
      outcome,
      context.citations,
    );
    this.approvals.remember(
      outcome.changeSet,
      outcome.continuation,
      chat.id,
      Boolean(chat.externalRoot),
      chat.context.vault,
      context.readableNoteIds,
      this.secretNotebookIds,
      context.citations,
    );
    await this.emitOutcome(
      chat.id,
      runId,
      outcome.changeSet,
      chat.context.autoApply,
      outcome.usage,
    );
  }

  private observer(
    request: { readonly chatId: string; readonly runId: string },
    deltas: DeltaBatcher,
  ): AgentObserver {
    return {
      onTextDelta: (delta): void => {
        this.markEndpointOnline();
        deltas.push(delta);
      },
      onToolStarted: (call): void => {
        this.markEndpointOnline();
        this.events.post(
          "tool.started",
          request.chatId,
          { toolCallId: call.id, name: call.name },
          request.runId,
        );
      },
      onToolCompleted: (result): void =>
        this.emitToolCompleted(request, result),
      onPlanUpdated: (plan): void => {
        this.markEndpointOnline();
        this.events.post(
          "run.plan",
          request.chatId,
          {
            items: plan.items.map((item) => ({
              id: item.id,
              content: item.content,
              status: item.status,
            })),
          },
          request.runId,
        );
      },
      onStep: (current, total, label): void => {
        this.markEndpointOnline();
        this.events.post(
          "run.progress",
          request.chatId,
          {
            current,
            total,
            label: label ?? `Model step ${current} of ${total}`,
          },
          request.runId,
        );
      },
    };
  }

  /**
   * Marks the endpoint online on first live agent activity and refreshes UI.
   *
   * Previously online was only set after the full run finished, so a long first
   * task kept showing Offline while the agent was already writing.
   *
   * @example this.markEndpointOnline()
   */
  private markEndpointOnline(): void {
    if (this.endpointStatus === "online") return;
    this.endpointStatus = "online";
    void this.sendSnapshot();
  }

  private emitToolCompleted(
    request: { readonly chatId: string; readonly runId: string },
    result: ToolExecutionResult,
  ): void {
    this.events.post(
      "tool.completed",
      request.chatId,
      {
        toolCallId: result.toolCallId,
        name: result.name,
        ok: true,
        summary: summarizeToolResult(result),
      },
      request.runId,
    );
  }

  private async appendUserMessage(
    chat: PersistedChat,
    content: string,
  ): Promise<PersistedChat> {
    const message: PersistedChatMessage = {
      id: randomUUID(),
      role: "user",
      content,
      createdAt: Date.now(),
    };
    const firstMessage = chat.messages.length === 0;
    const saved: PersistedChat = {
      ...chat,
      title: firstMessage
        ? content.trim().slice(0, 60) || chat.title
        : chat.title,
      updatedAt: Date.now(),
      messages: [...chat.messages, message],
    };
    await this.chats.save(saved);
    return saved;
  }

  private async emitOutcome(
    chatId: string,
    runId: string,
    changeSet: ChangeSet | null,
    autoApply: boolean,
    usage: TokenUsage | null,
  ): Promise<void> {
    const usagePayload = usage
      ? {
          promptTokens: usage.promptTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
        }
      : {};
    if (changeSet) {
      await this.approvals.resolveProposedChanges(changeSet, autoApply);
    } else {
      this.events.post(
        "run.completed",
        chatId,
        { summary: "Completed", ...usagePayload },
        runId,
      );
    }
    await this.sendSnapshot();
  }

  private async recordFailure(
    chatId: string,
    runId: string,
    error: unknown,
  ): Promise<void> {
    const domain =
      error instanceof DomainError
        ? error
        : new DomainError("PROVIDER", "Unexpected agent failure", error);
    if (domain.code !== "ABORTED" && !this.activeRuns.has(chatId)) {
      this.endpointStatus = "offline";
    }
    const chat = await this.chats.get(chatId);
    if (chat) {
      const summary: PersistedRunSummary = {
        runId,
        status: domain.code === "ABORTED" ? "cancelled" : "failed",
        summary: domain.message,
        completedAt: Date.now(),
      };
      await this.chats.save({
        ...chat,
        updatedAt: Date.now(),
        runSummaries: [...chat.runSummaries, summary],
      });
    }
    this.events.post(
      "run.failed",
      chatId,
      { code: domain.code, message: domain.message },
      runId,
    );
    await this.sendSnapshot();
  }

  private async renameChat(
    request: Extract<PanelRequest, { type: "chat.rename" }>,
  ): Promise<void> {
    const chat = await requireChat(this.chats, request.chatId);
    await this.chats.save({
      ...chat,
      title: request.payload.title.trim() || chat.title,
      updatedAt: Date.now(),
    });
    await this.sendSnapshot();
  }

  private async selectModel(model: string): Promise<void> {
    await this.providerConnector.selectModel(model);
    this.modelName = model.trim();
    await this.checkEndpoint();
  }

  private async searchContext(
    request: Extract<PanelRequest, { type: "context.search" }>,
  ): Promise<void> {
    const hits = this.mentionSearch
      ? await searchMentionHits(
          this.mentionSearch,
          request.payload.query,
          this.secretNotebookIds,
          request.payload.limit ?? 10,
        )
      : [];
    this.events.post("context.search.results", request.chatId, {
      requestId: request.payload.requestId,
      hits,
    });
  }

  private async updateContext(
    request: Extract<PanelRequest, { type: "context.update" }>,
  ): Promise<void> {
    const chat = await requireChat(this.chats, request.chatId);
    if (!(await this.allowAutoApplyUpdate(chat, request.payload.autoApply))) {
      await this.sendSnapshot();
      return;
    }
    await this.chats.save({
      ...chat,
      updatedAt: Date.now(),
      context: {
        ...request.payload,
        attachedNotebookIds: request.payload.attachedNotebookIds ?? [],
      },
    });
    await this.sendSnapshot();
  }

  private async allowAutoApplyUpdate(
    chat: PersistedChat,
    requested: boolean,
  ): Promise<boolean> {
    if (!requested || chat.context.autoApply) return true;
    return (await this.dialogs.showMessageBox(AUTO_APPLY_WARNING)) === 0;
  }

  private async selectFolder(chatId: string): Promise<void> {
    const selected = await this.dialogs.showOpenDialog({
      title: "Select text folder for this chat",
      properties: ["openDirectory", "createDirectory"],
    });
    const root = selected?.[0];
    if (!root) return;
    if (!path.isAbsolute(root)) {
      throw new DomainError(
        "VALIDATION",
        `Invalid selected folder ${safeValue(root)}; expected an absolute path`,
      );
    }
    const chat = await requireChat(this.chats, chatId);
    await this.chats.save({
      ...chat,
      updatedAt: Date.now(),
      externalRoot: root,
    });
    this.workspaces.setRoot(chatId, root);
    await this.sendSnapshot();
  }

  private async checkEndpoint(): Promise<void> {
    const busy = this.hasActiveRun();
    if (!busy) {
      this.endpointStatus = "checking";
      await this.sendSnapshot();
    }
    const check = await this.providerConnector.check();
    this.modelName = check.modelName;
    this.availableModels = check.availableModels;
    this.contextWindowMax = check.contextWindowMax;
    if (check.status === "online" || !this.hasActiveRun()) {
      this.endpointStatus = check.status;
    }
    await this.sendSnapshot();
  }

  /**
   * Reports whether any chat currently has an active run.
   *
   * @example if (this.hasActiveRun()) keepConnectionOnline()
   */
  private hasActiveRun(): boolean {
    return this.activeRuns.isBusy();
  }

  private async sendSnapshot(): Promise<void> {
    const summaries = await this.chats.list();
    const active = this.activeChatId
      ? await this.chats.get(this.activeChatId)
      : null;
    const chatId = active?.id ?? "bootstrap";
    this.events.post("state.snapshot", chatId, {
      chats: summaries,
      activeChat: active
        ? toActiveChat(active, this.changes, (changeSetId) =>
            this.approvals.applyTokenForChangeSet(changeSetId),
          )
        : null,
      endpointStatus: this.endpointStatus,
      modelName: this.modelName,
      privacyNotice: PRIVACY_NOTICE,
      secretNotebookIds: [...this.secretNotebookIds],
      availableModels: [...this.availableModels],
      contextWindowMax: this.contextWindowMax,
    });
  }
}
