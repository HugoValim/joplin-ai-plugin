import { InMemoryChangeSetStore } from "../../src/persistence/changeSetStore";
import { toChangeSetView } from "../../src/plugin/chatView";

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

    expect(toChangeSetView(changeSet).changes[0]).toMatchObject({
      kind: "notebook",
      targetId: "folder-1",
      targetLabel: "Projects",
    });
  });
});
