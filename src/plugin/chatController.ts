import { randomUUID } from "crypto";
import path from "path";
import type { AgentRunOutcome, TokenUsage } from "../agent/agentRunner";
import type { ChangeApplier } from "../agent/changeApplier";
import type { ContextBuilder } from "../agent/contextBuilder";
import type { ChangeSet, ChangeSetStore } from "../persistence/changeSetStore";
import { ChangeSetLifecycle } from "../persistence/changeSetLifecycle";
import type {
  ChatStore,
  PersistedChat,
  PersistedChatMessage,
} from "../persistence/chatStore";
import { DomainError, safeValue } from "../shared/errors";
import type { ActiveChatView, PanelRequest } from "../shared/protocol";
import { isSafeExternalMarkdownUrl } from "../shared/safeExternalUrl";
import {
  resolveSelectionRange,
  type LineRange,
  type NoteSelectionRef,
  type SelectionRefInput,
} from "../shared/selectionRef";
import { searchMentionHits, type MentionSearchPort } from "./mentionSearch";
import type { ToolRegistry } from "../tools/toolRegistry";
import { loadSystemPrompt, type SettingsPort } from "./settings";
import type { PanelPort } from "./panelPort";
import type { PerChatWorkspaceResolver } from "./workspaceAdapters";
import { mergeHistory, toActiveChat } from "./chatView";
import {
  deleteChatAndChooseNext,
  lastUserMessage,
  requireChat,
  truncateForRegenerate,
} from "./chatLifecycle";
import { ProviderConnector, type EndpointStatus } from "./providerConnector";
import { RunCancellationRegistry } from "./runCancellationRegistry";
import { PRIVACY_NOTICE } from "./privacy";
import { PluginEventSender } from "./pluginEventSender";
import type { AssistantOutputActions } from "./assistantOutputActions";
import type { CommandPort, DialogPort, ProviderFactory } from "./types";
import { ApprovalWorkflow } from "./approvalWorkflow";
import type { SecretNotebookStore } from "../persistence/secretNotebookStore";
import { NoOpReviewNotePort, type ReviewNotePort } from "./reviewNoteService";
import {
  ModelRunLifecycle,
  type PreparedInitialModelRun,
} from "./modelRunLifecycle";

const AUTO_APPLY_WARNING =
  "Security warning: Bypass permissions will auto-apply every model-proposed non-delete change, then keep an inline Keep/Undo review in the sidebar. Deletions still require manual ChangeReview before apply. Conflicts are still blocked. Enable for this chat?";

const MAX_ATTACHED_NOTES = 50;
const MAX_ATTACHED_NOTEBOOKS = 20;
const MAX_SELECTION_REFS = 20;

export interface DropSelectionPort {
  selectedNoteIds(): Promise<readonly string[]>;
  selectedFolderId(): Promise<string | null>;
}

interface ChatRunSource {
  readonly chat: PersistedChat;
  readonly userText: string;
}

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
  private readonly changeSetLifecycle: ChangeSetLifecycle;
  private readonly modelRuns: ModelRunLifecycle;
  private recoveredPendingChangeSet: ChangeSet | null = null;

  public constructor(
    private readonly panel: PanelPort,
    private readonly chats: ChatStore,
    private readonly contextBuilder: ContextBuilder,
    tools: ToolRegistry,
    private readonly changes: ChangeSetStore,
    private readonly applier: ChangeApplier,
    private readonly workspaces: PerChatWorkspaceResolver,
    private readonly settings: SettingsPort,
    private readonly dialogs: DialogPort,
    private readonly commands: CommandPort,
    private readonly assistantActions: AssistantOutputActions,
    private readonly secretNotebooks: SecretNotebookStore,
    createProvider: ProviderFactory,
    reviewNotes: ReviewNotePort = new NoOpReviewNotePort(),
    private readonly mentionSearch: MentionSearchPort | null = null,
    private readonly dropSelection: DropSelectionPort | null = null,
  ) {
    this.providerConnector = new ProviderConnector(
      settings,
      dialogs,
      createProvider,
    );
    this.events = new PluginEventSender(panel);
    this.modelRuns = new ModelRunLifecycle(
      chats,
      tools,
      this.changes,
      this.events,
      this.activeRuns,
    );
    this.changeSetLifecycle = new ChangeSetLifecycle(
      this.changes,
      chats,
      reviewNotes,
    );
    this.approvals = new ApprovalWorkflow(
      chats,
      this.changes,
      applier,
      tools,
      this.providerConnector,
      this.events,
      this.activeRuns,
      reviewNotes,
      this.changeSetLifecycle,
      this.modelRuns,
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
        await this.approvals.abandonChat(request.chatId);
        await this.chats.clear(request.chatId);
        await this.sendSnapshot();
        return;
      case "chat.delete":
        this.activeRuns.cancelChat(request.chatId, "Chat deleted");
        await this.approvals.abandonChat(request.chatId);
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
      case "context.attachDropped":
        await this.attachDropped(request);
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
   * Attaches a line-range selection ref to the active chat composer.
   *
   * @example await controller.attachSelectionRef({ noteId, title, body, selection })
   */
  public async attachSelectionRef(input: SelectionRefInput): Promise<void> {
    const chatId = this.activeChatId;
    if (!chatId) return;
    await this.persistSelectionRef(chatId, input);
  }

  /**
   * Creates a new chat and optionally attaches a selection line-range ref.
   *
   * @example await controller.startNewChatWithSelection(refInput)
   */
  public async startNewChatWithSelection(
    input: SelectionRefInput | null,
  ): Promise<void> {
    await this.createChat();
    const chatId = this.activeChatId;
    if (!chatId || !input) return;
    await this.persistSelectionRef(chatId, input);
  }

  /**
   * Stores a selection ref and shows it in the composer as `@Title:L12-L40`.
   *
   * When the selection cannot be located in the body (Rich Text hands us
   * rendered text), it degrades to the note's full line range rather than a
   * bare `@Title`, so the composer never hides that a selection was requested.
   */
  private async persistSelectionRef(
    chatId: string,
    input: SelectionRefInput,
  ): Promise<void> {
    const chat = await requireChat(this.chats, chatId);
    const range = resolveSelectionRange(input) ?? wholeBodyRange(input.body);
    if (!range) {
      const attachedNoteIds = appendUniqueId(
        chat.context.attachedNoteIds,
        input.noteId,
        MAX_ATTACHED_NOTES,
      );
      await this.chats.save({
        ...chat,
        updatedAt: Date.now(),
        context: { ...chat.context, attachedNoteIds },
      });
      this.events.post("context.dropped", chatId, {
        hits: [
          {
            kind: "note",
            id: input.noteId,
            title: input.title.trim() || "Untitled",
          },
        ],
      });
      await this.sendSnapshot();
      return;
    }
    const selectionRef: NoteSelectionRef = {
      noteId: input.noteId,
      startLine: range.startLine,
      endLine: range.endLine,
    };
    const attachedNoteIds = appendUniqueId(
      chat.context.attachedNoteIds,
      input.noteId,
      MAX_ATTACHED_NOTES,
    );
    const selectionRefs = appendSelectionRef(
      chat.context.selectionRefs ?? [],
      selectionRef,
      MAX_SELECTION_REFS,
    );
    await this.chats.save({
      ...chat,
      updatedAt: Date.now(),
      context: { ...chat.context, attachedNoteIds, selectionRefs },
    });
    this.events.post("composer.selectionRef", chatId, {
      title: input.title.trim() || "Untitled",
      startLine: range.startLine,
      endLine: range.endLine,
    });
    await this.sendSnapshot();
  }

  private async selectChat(chatId: string): Promise<void> {
    const chat = await requireChat(this.chats, chatId);
    this.recoveredPendingChangeSet = await this.changeSetLifecycle.recover(
      chat,
      this.applier,
    );
    this.activeChatId = chat.id;
    this.workspaces.setRoot(chat.id, chat.externalRoot);
    await this.sendSnapshot();
  }

  private async submit(
    request: Extract<PanelRequest, { type: "chat.submit" }>,
  ): Promise<void> {
    await this.startRun(request.chatId, request.runId, async () => {
      const chat = await requireChat(this.chats, request.chatId);
      const saved = await this.appendUserMessage(chat, request.payload.text);
      return { chat: saved, userText: request.payload.text };
    });
  }

  private async retry(
    request: Extract<PanelRequest, { type: "chat.retry" }>,
  ): Promise<void> {
    await this.startRun(request.chatId, request.runId, async () => {
      const chat = await requireChat(this.chats, request.chatId);
      const userMessage = lastUserMessage(chat);
      if (!userMessage) {
        throw new DomainError(
          "NOT_AVAILABLE",
          `Chat ${safeValue(chat.id)} has no user message to retry; expected at least one user turn`,
        );
      }
      return { chat, userText: userMessage.content };
    });
  }

  private async regenerate(
    request: Extract<PanelRequest, { type: "chat.regenerate" }>,
  ): Promise<void> {
    await this.startRun(request.chatId, request.runId, async () => {
      const chat = await requireChat(this.chats, request.chatId);
      const truncated = truncateForRegenerate(chat, request.payload.messageId);
      await this.chats.save(truncated);
      const userMessage = lastUserMessage(truncated);
      if (!userMessage) {
        throw new DomainError(
          "NOT_AVAILABLE",
          `Chat ${safeValue(chat.id)} has no user message before regenerate target; expected a prior user turn`,
        );
      }
      return { chat: truncated, userText: userMessage.content };
    });
  }

  private async startRun(
    chatId: string,
    runId: string,
    loadSource: () => Promise<ChatRunSource>,
  ): Promise<void> {
    await this.modelRuns.start({
      chatId,
      runId,
      prepare: async () => {
        const source = await loadSource();
        return this.prepareInitialRun(source);
      },
      onOutcome: async (outcome, prepared) => {
        await this.handleInitialOutcome(runId, outcome, prepared);
      },
      onActivity: () => this.markEndpointOnline(),
      onFailure: async (failure) => {
        if (failure.code !== "ABORTED" && !this.activeRuns.has(chatId)) {
          this.endpointStatus = "offline";
        }
        await this.sendSnapshot();
      },
    });
  }

  private async prepareInitialRun(
    source: ChatRunSource,
  ): Promise<PreparedInitialModelRun> {
    const session = await this.providerConnector.connectWithConfirmation();
    this.modelName = session.config.model;
    const context = await this.contextBuilder.build({
      systemPrompt: await loadSystemPrompt(this.settings),
      modelName: session.config.model,
      userText: source.userText,
      settings: source.chat.context,
      hasFileWorkspace: Boolean(source.chat.externalRoot),
      secretNotebookIds: this.secretNotebookIds,
    });
    this.activeChatId = source.chat.id;
    await this.sendSnapshot();
    return {
      provider: session.provider,
      submittedChat: source.chat,
      citations: context.citations,
      request: {
        messages: mergeHistory(context.messages, source.chat.messages),
        hasFileWorkspace: Boolean(source.chat.externalRoot),
        vault: source.chat.context.vault,
        readOnly: source.chat.context.interactionMode === "ask",
        readableNoteIds: context.readableNoteIds,
        secretNotebookIds: this.secretNotebookIds,
      },
    };
  }

  private async handleInitialOutcome(
    runId: string,
    outcome: AgentRunOutcome,
    prepared: PreparedInitialModelRun,
  ): Promise<void> {
    this.markEndpointOnline();
    this.approvals.remember(
      outcome.changeSet,
      outcome.continuation,
      prepared.submittedChat.id,
      prepared.request.hasFileWorkspace,
      prepared.request.vault,
      prepared.request.readableNoteIds,
      prepared.request.secretNotebookIds,
      prepared.citations,
    );
    await this.emitOutcome(
      prepared.submittedChat.id,
      runId,
      outcome.changeSet,
      prepared.submittedChat.context.autoApply,
      outcome.usage,
    );
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

  private async attachDropped(
    request: Extract<PanelRequest, { type: "context.attachDropped" }>,
  ): Promise<void> {
    const chat = await requireChat(this.chats, request.chatId);
    const hits = await this.resolveDroppedHits(request.payload);
    if (hits.length === 0) {
      await this.sendSnapshot();
      return;
    }
    let attachedNoteIds = [...chat.context.attachedNoteIds];
    let attachedNotebookIds = [...(chat.context.attachedNotebookIds ?? [])];
    for (const hit of hits) {
      if (hit.kind === "note") {
        attachedNoteIds = appendUniqueId(
          attachedNoteIds,
          hit.id,
          MAX_ATTACHED_NOTES,
        );
      } else {
        attachedNotebookIds = appendUniqueId(
          attachedNotebookIds,
          hit.id,
          MAX_ATTACHED_NOTEBOOKS,
        );
      }
    }
    await this.chats.save({
      ...chat,
      updatedAt: Date.now(),
      context: {
        ...chat.context,
        attachedNoteIds,
        attachedNotebookIds,
      },
    });
    this.events.post("context.dropped", request.chatId, { hits });
    await this.sendSnapshot();
  }

  private async resolveDroppedHits(
    payload: Extract<
      PanelRequest,
      { type: "context.attachDropped" }
    >["payload"],
  ): Promise<
    readonly { kind: "note" | "notebook"; id: string; title: string }[]
  > {
    const kind = payload.kind;
    const explicitIds = payload.ids ?? [];
    if (explicitIds.length > 0) {
      if (kind === "notebook") {
        return this.resolveNotebookHits(explicitIds);
      }
      return this.resolveNoteHits(explicitIds);
    }
    if (!this.dropSelection) return [];
    if (kind !== "notebook") {
      const noteIds = await this.dropSelection.selectedNoteIds();
      if (noteIds.length > 0) return this.resolveNoteHits(noteIds);
    }
    if (kind === "note") return [];
    const folderId = await this.dropSelection.selectedFolderId();
    return folderId ? this.resolveNotebookHits([folderId]) : [];
  }

  private async resolveNoteHits(
    ids: readonly string[],
  ): Promise<{ kind: "note"; id: string; title: string }[]> {
    const hits: { kind: "note"; id: string; title: string }[] = [];
    for (const id of ids.slice(0, MAX_ATTACHED_NOTES)) {
      const title = await this.resolveNoteTitle(id);
      hits.push({ kind: "note", id, title });
    }
    return hits;
  }

  private async resolveNotebookHits(
    ids: readonly string[],
  ): Promise<{ kind: "notebook"; id: string; title: string }[]> {
    const hits: { kind: "notebook"; id: string; title: string }[] = [];
    for (const id of ids.slice(0, MAX_ATTACHED_NOTEBOOKS)) {
      const title = await this.resolveNotebookTitle(id);
      hits.push({ kind: "notebook", id, title });
    }
    return hits;
  }

  private async resolveNoteTitle(noteId: string): Promise<string> {
    if (!this.mentionSearch) return noteId;
    try {
      const note = await this.mentionSearch.readNote(noteId);
      return note.title.trim() || "Untitled";
    } catch {
      return noteId;
    }
  }

  private async resolveNotebookTitle(notebookId: string): Promise<string> {
    if (!this.mentionSearch) return notebookId;
    try {
      const notebooks = await this.mentionSearch.listNotebooks();
      const match = notebooks.find((notebook) => notebook.id === notebookId);
      return match?.title.trim() || "Untitled notebook";
    } catch {
      return notebookId;
    }
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
        selectionRefs:
          request.payload.selectionRefs ?? chat.context.selectionRefs ?? [],
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
      activeChat: active ? this.createActiveChatView(active) : null,
      endpointStatus: this.endpointStatus,
      modelName: this.modelName,
      privacyNotice: PRIVACY_NOTICE,
      secretNotebookIds: [...this.secretNotebookIds],
      availableModels: [...this.availableModels],
      contextWindowMax: this.contextWindowMax,
    });
  }

  private createActiveChatView(chat: PersistedChat): ActiveChatView {
    const recovered = this.recoveredPendingChangeSet;
    const persisted = chat.pendingChangeSet;
    const runtime = persisted ? this.changes.get(persisted.id) : null;
    const pending =
      runtime ??
      (recovered && recovered.id === persisted?.id ? recovered : persisted);
    const applyToken = pending
      ? this.approvals.applyTokenForChangeSet(pending.id)
      : "";
    return toActiveChat({ ...chat, pendingChangeSet: pending }, applyToken);
  }
}

function appendUniqueId(
  ids: readonly string[],
  id: string,
  max: number,
): string[] {
  if (!id.trim() || ids.includes(id) || ids.length >= max) return [...ids];
  return [...ids, id];
}

function wholeBodyRange(body: string): LineRange | null {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  if (!body.trim()) return null;
  return { startLine: 1, endLine: lines.length };
}

function appendSelectionRef(
  refs: readonly NoteSelectionRef[],
  next: NoteSelectionRef,
  max: number,
): NoteSelectionRef[] {
  const duplicate = refs.some(
    (ref) =>
      ref.noteId === next.noteId &&
      ref.startLine === next.startLine &&
      ref.endLine === next.endLine,
  );
  if (duplicate || refs.length >= max) return [...refs];
  return [...refs, next];
}
