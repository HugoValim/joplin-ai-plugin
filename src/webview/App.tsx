import type { ActiveChatView } from "../shared/protocol";
import { Composer } from "./Composer";
import { ContextSummary } from "./ContextSummary";
import { ChangeReview } from "./ChangeReview";
import { promptSuggestions } from "./promptSuggestions";
import { RunActivity, RunLiveRegion } from "./RunStatus";
import { SidebarHeader } from "./SidebarHeader";
import { Transcript } from "./Transcript";
import { useSidebarController } from "./useSidebarController";

/**
 * Composes the fixed shell rows and routes state through focused components.
 *
 * @example createRoot(root).render(<App />)
 */
export function App(): JSX.Element {
  const controller = useSidebarController();
  const { state } = controller;
  const activeChat = state.snapshot.activeChat;
  const pendingChanges = activeChat?.pendingChangeSet ?? null;
  const hasActivity = Boolean(
    state.tools.length || state.plan.length || state.progress || state.failure,
  );
  const activity = hasActivity ? (
    <RunActivity
      tools={state.tools}
      plan={state.plan}
      progress={state.progress}
      failure={state.failure}
      canRetry={Boolean(state.failure && !state.busy && !pendingChanges)}
      onRetry={controller.retry}
    />
  ) : null;
  // Composer stays editable while busy (queue follow-ups); ChangeReview still locks it.
  const shellLocked = state.busy || Boolean(pendingChanges);
  const composerDisabled = Boolean(pendingChanges);

  return (
    <main className={`app-shell${pendingChanges ? " has-review" : ""}`}>
      <aside
        className="panel-width-guard"
        role="status"
        aria-label="Panel too narrow"
      >
        <span className="panel-width-guard-icon" aria-hidden="true">
          ↔
        </span>
        <strong>Widen panel</strong>
        <span className="panel-width-guard-detail">Minimum width: 280px</span>
      </aside>
      <SidebarHeader
        snapshot={state.snapshot}
        busy={state.busy}
        onSelectChat={controller.selectChat}
        onCreateChat={controller.createChat}
        onClearChat={controller.clearChat}
        onDeleteChat={controller.deleteChat}
        onRenameChat={controller.renameChat}
        onSelectModel={controller.selectModel}
      />
      {activeChat ? (
        <ContextSummary
          chat={activeChat}
          activeNote={state.activeNote}
          secretNotebookIds={state.snapshot.secretNotebookIds}
          disabled={shellLocked}
          onUpdate={controller.updateContext}
          onToggleAttached={controller.toggleAttachedNote}
          onSelectFolder={controller.selectFolder}
          onMarkSecret={controller.markSecretNotebook}
          onUnmarkSecret={controller.unmarkSecretNotebook}
        />
      ) : (
        <div className="context-placeholder" aria-hidden="true" />
      )}
      <div className="main-pane">
        <Transcript
          chatId={activeChat?.id ?? "bootstrap"}
          messages={activeChat?.messages ?? []}
          runSummaries={activeChat?.runSummaries ?? []}
          streamingText={state.streamingText}
          busy={state.busy}
          submissionSequence={state.submissionSequence}
          onOpenNote={controller.openNote}
          onAssistantAction={controller.runAssistantAction}
          onRegenerate={controller.regenerate}
          onSuggestion={controller.useSuggestion}
          suggestions={
            activeChat
              ? promptSuggestions(activeChat, state.activeNote)
              : undefined
          }
          noteActionsDisabled={shellLocked || !state.activeNote}
          activity={activity}
        />
        {activeChat && pendingChanges ? (
          <ChangeReview
            changeSet={pendingChanges}
            acceptedIds={controller.acceptedIds}
            disabled={state.busy}
            phase={state.phase}
            onToggle={controller.toggleChange}
            onSelectAll={controller.selectAllChanges}
            onSelectNone={controller.selectNoChanges}
            onApply={controller.applyChanges}
            onDiscard={controller.discardChanges}
            onDeny={controller.denyChanges}
            onOpenReview={controller.openReview}
          />
        ) : null}
      </div>
      {activeChat ? (
        <ModeControl
          mode={activeChat.context.interactionMode}
          disabled={shellLocked}
          onUpdate={controller.updateContext}
        />
      ) : null}
      <Composer
        key={activeChat?.id ?? "bootstrap"}
        draft={controller.draft}
        busy={state.busy}
        disabled={composerDisabled}
        phase={pendingChanges ? "Resolve proposed changes to continue" : state.phase}
        focusSequence={state.focusSequence}
        lastRunId={state.lastRunId}
        lastUsage={state.lastUsage}
        contextWindowMax={state.snapshot.contextWindowMax}
        queuedMessage={state.queuedMessage}
        onQueue={controller.queueMessage}
        history={composerHistory(activeChat?.messages ?? [])}
        onDraftChange={controller.setDraft}
        onSubmit={controller.submit}
        onCancel={controller.cancel}
        onUndo={controller.undo}
      />
      <RunLiveRegion announcement={state.phase} />
    </main>
  );
}

/**
 * Collects chronological user prompt texts for composer ArrowUp recall.
 *
 * @example composerHistory(chat.messages)
 */
function ModeControl({
  mode,
  disabled,
  onUpdate,
}: {
  readonly mode: "ask" | "agent";
  readonly disabled: boolean;
  readonly onUpdate: (next: { interactionMode: "ask" | "agent" }) => void;
}): JSX.Element {
  return (
    <div className="mode-control" role="group" aria-label="Interaction mode">
      <button
        type="button"
        disabled={disabled}
        aria-pressed={mode === "ask"}
        onClick={() => onUpdate({ interactionMode: "ask" })}
      >
        Ask
      </button>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={mode === "agent"}
        onClick={() => onUpdate({ interactionMode: "agent" })}
      >
        Agent
      </button>
    </div>
  );
}

function composerHistory(
  messages: ActiveChatView["messages"],
): readonly string[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.content);
}
