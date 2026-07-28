import { randomUUID } from "crypto";
import path from "path";
import { AgentRunner, type AgentObserver } from "../agent/agentRunner";
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
import type { ToolRegistry, ToolExecutionResult } from "../tools/toolRegistry";
import { loadSystemPrompt, type SettingsPort } from "./settings";
import type { PanelPort } from "./panelPort";
import type { PerChatWorkspaceResolver } from "./workspaceAdapters";
import { DeltaBatcher } from "./deltaBatcher";
import { mergeHistory, toActiveChat } from "./chatView";
import {
  deleteChatAndChooseNext,
  persistRunOutcome,
  requireChat,
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

const AUTO_APPLY_WARNING =
  "Security warning: Auto-apply will apply every model-proposed file change in the selected folder without review. Note and notebook proposals always require manual review. Conflicts are still blocked and Undo remains available where supported. Enable for this chat?";

export class ChatController {
  private activeChatId: string | null = null;
  private endpointStatus: EndpointStatus = "unconfigured";
  private modelName = "";
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
      case "chat.submit":
        await this.submit(request);
        return;
      case "run.cancel":
        this.activeRuns.cancel(request.chatId, request.runId);
        return;
      case "context.update":
        await this.updateContext(request);
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
      case "run.undo":
        await this.approvals.undo(request);
        await this.sendSnapshot();
        return;
      case "note.open":
        await this.commands.execute("openNote", request.payload.noteId);
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

  private async selectChat(chatId: string): Promise<void> {
    const chat = await requireChat(this.chats, chatId);
    this.activeChatId = chat.id;
    this.workspaces.setRoot(chat.id, chat.externalRoot);
    await this.sendSnapshot();
  }

  private async submit(
    request: Extract<PanelRequest, { type: "chat.submit" }>,
  ): Promise<void> {
    const abortController = new AbortController();
    if (
      !this.activeRuns.tryStart(request.chatId, request.runId, abortController)
    ) {
      throw new DomainError(
        "CONFLICT",
        `Chat ${safeValue(request.chatId)} already has an active run; expected one run at a time`,
      );
    }
    this.events.post(
      "run.started",
      request.chatId,
      { startedAt: Date.now() },
      request.runId,
    );
    const deltaBatcher = new DeltaBatcher((delta) => {
      this.events.post(
        "assistant.delta",
        request.chatId,
        { delta },
        request.runId,
      );
    });
    try {
      await this.executeRun(request, abortController.signal, deltaBatcher);
    } catch (error: unknown) {
      deltaBatcher.flush();
      await this.recordFailure(request, error);
    } finally {
      deltaBatcher.dispose();
      this.activeRuns.clearIfCurrent(request.chatId, abortController);
    }
  }

  private async executeRun(
    request: Extract<PanelRequest, { type: "chat.submit" }>,
    abortSignal: AbortSignal,
    deltaBatcher: DeltaBatcher,
  ): Promise<void> {
    const chat = await requireChat(this.chats, request.chatId);
    const session = await this.providerConnector.connectWithConfirmation();
    this.modelName = session.config.model;
    const context = await this.contextBuilder.build({
      systemPrompt: await loadSystemPrompt(this.settings),
      modelName: session.config.model,
      userText: request.payload.text,
      settings: chat.context,
      hasFileWorkspace: Boolean(chat.externalRoot),
      secretNotebookIds: this.secretNotebookIds,
    });
    const saved = await this.appendUserMessage(chat, request.payload.text);
    const runner = new AgentRunner(
      session.provider,
      this.tools,
      this.changes,
      this.observer(request, deltaBatcher),
    );
    const outcome = await runner.run(
      {
        chatId: chat.id,
        runId: request.runId,
        messages: mergeHistory(context.messages, chat.messages),
        hasFileWorkspace: Boolean(chat.externalRoot),
        vault: chat.context.vault,
        readableNoteIds: context.readableNoteIds,
        secretNotebookIds: this.secretNotebookIds,
      },
      abortSignal,
    );
    deltaBatcher.flush();
    this.endpointStatus = "online";
    await persistRunOutcome(
      this.chats,
      saved,
      request.runId,
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
      request.runId,
      outcome.changeSet,
      chat.context.autoApply,
    );
  }

  private observer(
    request: Extract<PanelRequest, { type: "chat.submit" }>,
    deltas: DeltaBatcher,
  ): AgentObserver {
    return {
      onTextDelta: (delta): void => deltas.push(delta),
      onToolStarted: (call): void => {
        this.events.post(
          "tool.started",
          request.chatId,
          { toolCallId: call.id, name: call.name },
          request.runId,
        );
      },
      onToolCompleted: (result): void =>
        this.emitToolCompleted(request, result),
      onStep: (current, total): void => {
        this.events.post(
          "run.progress",
          request.chatId,
          { current, total, label: `Model step ${current} of ${total}` },
          request.runId,
        );
      },
    };
  }

  private emitToolCompleted(
    request: Extract<PanelRequest, { type: "chat.submit" }>,
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
  ): Promise<void> {
    if (changeSet) {
      await this.approvals.resolveProposedChanges(changeSet, autoApply);
    } else {
      this.events.post(
        "run.completed",
        chatId,
        { summary: "Completed" },
        runId,
      );
    }
    await this.sendSnapshot();
  }

  private async recordFailure(
    request: Extract<PanelRequest, { type: "chat.submit" }>,
    error: unknown,
  ): Promise<void> {
    const domain =
      error instanceof DomainError
        ? error
        : new DomainError("PROVIDER", "Unexpected agent failure", error);
    if (domain.code !== "ABORTED") this.endpointStatus = "offline";
    const chat = await this.chats.get(request.chatId);
    if (chat) {
      const summary: PersistedRunSummary = {
        runId: request.runId,
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
      request.chatId,
      { code: domain.code, message: domain.message },
      request.runId,
    );
    await this.sendSnapshot();
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
      context: request.payload,
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
    this.endpointStatus = "checking";
    await this.sendSnapshot();
    const check = await this.providerConnector.check();
    this.modelName = check.modelName;
    this.endpointStatus = check.status;
    await this.sendSnapshot();
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
    });
  }
}
