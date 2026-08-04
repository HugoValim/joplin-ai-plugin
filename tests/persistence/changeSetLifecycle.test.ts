import {
  InMemoryChangeSetStore,
  type ChangeSet,
} from "../../src/persistence/changeSetStore";
import { ChangeSetLifecycle } from "../../src/persistence/changeSetLifecycle";
import type { PersistedChat } from "../../src/persistence/chatStore";

describe("ChangeSetLifecycle", () => {
  test("recovers a persisted pending Change Set", () => {
    const changes = new InMemoryChangeSetStore();
    const lifecycle = new ChangeSetLifecycle(changes);
    const pending = sampleChangeSet("pending-1", "run-1", "proposed");

    lifecycle.recover(sampleChat({ pendingChangeSet: pending }));

    expect(changes.get(pending.id)).toEqual(pending);
  });

  test("recovers a parked applied Change Set", () => {
    const changes = new InMemoryChangeSetStore();
    const lifecycle = new ChangeSetLifecycle(changes);
    const applied = sampleChangeSet("applied-1", "run-1", "applied");

    lifecycle.recover(sampleChat({ parkedAppliedChangeSet: applied }));

    expect(changes.get(applied.id)).toEqual(applied);
  });

  test("does nothing when persisted Change Set references are missing", () => {
    const changes = new InMemoryChangeSetStore();
    const lifecycle = new ChangeSetLifecycle(changes);

    lifecycle.recover(sampleChat());

    expect(changes.getByRun("run-1")).toBeNull();
  });

  test("rejects a malformed persisted Change Set reference", () => {
    const changes = new InMemoryChangeSetStore();
    const lifecycle = new ChangeSetLifecycle(changes);
    const malformed = {
      ...sampleChangeSet("bad-1", "run-1", "proposed"),
      chatId: undefined,
    };

    expect(() =>
      lifecycle.recover(
        sampleChat({ pendingChangeSet: malformed as unknown as ChangeSet }),
      ),
    ).toThrow("expected a schema-v1 proposal batch");
  });

  test("repeated recovery leaves the same runtime state", () => {
    const changes = new InMemoryChangeSetStore();
    const lifecycle = new ChangeSetLifecycle(changes);
    const pending = sampleChangeSet("pending-1", "run-new", "proposed");
    const parked = sampleChangeSet("applied-1", "run-old", "applied");
    const chat = sampleChat({
      pendingChangeSet: pending,
      parkedAppliedChangeSet: parked,
    });

    lifecycle.recover(chat);
    lifecycle.recover(chat);

    expect(changes.get(pending.id)).toEqual(pending);
    expect(changes.get(parked.id)).toEqual(parked);
  });
});

function sampleChat(overrides: Partial<PersistedChat> = {}): PersistedChat {
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
    pendingChangeSet: null,
    parkedAppliedChangeSet: null,
    ...overrides,
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

function sampleChangeSet(
  id: string,
  runId: string,
  status: ChangeSet["status"],
): ChangeSet {
  return {
    id,
    chatId: "chat-1",
    runId,
    createdAt: 1,
    status,
    changes: [],
  };
}
