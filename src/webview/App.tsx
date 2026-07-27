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
    state.tools.length || state.progress || state.failure,
  );
  const activity = hasActivity ? (
    <RunActivity
      tools={state.tools}
      progress={state.progress}
      failure={state.failure}
    />
  ) : null;

  return (
    <main className="app-shell">
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
      />
      {activeChat ? (
        <ContextSummary
          chat={activeChat}
          activeNote={state.activeNote}
          disabled={state.busy || Boolean(pendingChanges)}
          onUpdate={controller.updateContext}
          onToggleAttached={controller.toggleAttachedNote}
          onSelectFolder={controller.selectFolder}
        />
      ) : (
        <div className="context-placeholder" aria-hidden="true" />
      )}
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
        />
      ) : (
        <>
          <Transcript
            chatId={activeChat?.id ?? "bootstrap"}
            messages={activeChat?.messages ?? []}
            streamingText={state.streamingText}
            busy={state.busy}
            submissionSequence={state.submissionSequence}
            onOpenNote={controller.openNote}
            onAssistantAction={controller.runAssistantAction}
            onSuggestion={controller.useSuggestion}
            suggestions={
              activeChat
                ? promptSuggestions(activeChat, state.activeNote)
                : undefined
            }
            noteActionsDisabled={state.busy || !state.activeNote}
            activity={activity}
          />
          <Composer
            key={activeChat?.id ?? "bootstrap"}
            draft={controller.draft}
            busy={state.busy}
            phase={state.phase}
            focusSequence={state.focusSequence}
            lastRunId={state.lastRunId}
            history={composerHistory(activeChat?.messages ?? [])}
            onDraftChange={controller.setDraft}
            onSubmit={controller.submit}
            onCancel={controller.cancel}
            onUndo={controller.undo}
          />
        </>
      )}
      <RunLiveRegion announcement={state.phase} />
    </main>
  );
}

/**
 * Collects chronological user prompt texts for composer ArrowUp recall.
 *
 * @example composerHistory(chat.messages)
 */
function composerHistory(
  messages: ActiveChatView["messages"],
): readonly string[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.content);
}
