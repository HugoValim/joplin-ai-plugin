import {
  InMemoryChangeSetStore,
  type ChangeSet,
} from "../../src/persistence/changeSetStore";
import type { PersistedChat } from "../../src/persistence/chatStore";
import { toActiveChat, toChangeSetView } from "../../src/plugin/chatView";

describe("chat change-set view", () => {
  test("maps notebook proposals to their notebook ID", () => {
    const changes = new InMemoryChangeSetStore();
    changes.add("chat-1", "run-1", {
      kind: "notebook",
      operation: "rename",
      notebookId: "folder-1",
      expectedUpdatedTime: 40,
      title: "Active projects",
      targetLabel: "Projects",
      before: "Title: Projects",
      after: "Title: Active projects",
    });
    const changeSet = changes.getByRun("run-1");
    if (!changeSet) throw new Error("Expected change set");

    expect(toChangeSetView(changeSet, "b".repeat(64)).changes[0]).toMatchObject(
      {
        kind: "notebook",
        targetId: "folder-1",
        targetLabel: "Projects",
      },
    );
  });
});

describe("toActiveChat", () => {
  test("projects a persisted pending Change Set without a runtime store", () => {
    const pending = sampleChangeSet();

    const active = toActiveChat(sampleChat(pending), "token-for-pending-1");

    expect(active.pendingChangeSet).toMatchObject({
      changeSetId: "pending-1",
      runId: "run-1",
      applyToken: "token-for-pending-1",
    });
  });
});

function sampleChat(pendingChangeSet: ChangeSet): PersistedChat {
  return {
    schemaVersion: 1,
    id: "chat-1",
    title: "Recovery",
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    context: sampleContext,
    externalRoot: null,
    references: [],
    runSummaries: [],
    pendingChangeSet,
    parkedAppliedChangeSet: null,
  };
}

const sampleContext: PersistedChat["context"] = {
  activeNote: true,
  vault: false,
  autoApply: false,
  interactionMode: "agent",
  attachedNoteIds: [],
  attachedNotebookIds: [],
  selectionRefs: [],
};

function sampleChangeSet(): ChangeSet {
  return {
    id: "pending-1",
    chatId: "chat-1",
    runId: "run-1",
    createdAt: 1,
    status: "proposed",
    changes: [],
  };
}
