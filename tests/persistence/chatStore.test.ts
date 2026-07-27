import { ChatStore } from "../../src/persistence/chatStore";
import { InMemoryChangeSetStore } from "../../src/persistence/changeSetStore";
import { MemoryJsonFilePort } from "../fakes/memoryJsonFilePort";

describe("ChatStore", () => {
  test("quarantines a corrupt chat and continues loading other chats", async () => {
    const files = new MemoryJsonFilePort();
    const reported: string[] = [];
    const store = new ChatStore("/plugin", files, (message) => {
      reported.push(message);
    });
    const broken = await store.create("Broken");
    files.files.set(`/plugin/chats/${broken.id}.json`, '{"schemaVersion":1,');

    const quarantined = await store.get(broken.id);
    const healthy = await store.create("Healthy chat");

    expect(quarantined).toBeNull();
    expect(files.renamed[0]).toContain(`${broken.id}.json.corrupt-`);
    expect(reported[0]).toContain(broken.id);
    expect(await store.list()).toEqual([
      expect.objectContaining({ id: healthy.id }),
    ]);
    expect(await store.get(healthy.id)).toEqual(healthy);
  });

  test("persists a pending approval batch with its chat", async () => {
    const files = new MemoryJsonFilePort();
    const store = new ChatStore("/plugin", files);
    const chat = await store.create("Review");
    const changes = new InMemoryChangeSetStore();
    changes.add(chat.id, "run-1", {
      kind: "file",
      relativePath: "guide.md",
      targetLabel: "guide.md",
      before: "Old",
      after: "New",
      expectedSha256: "abc123",
    });
    const pendingChangeSet = changes.getByRun("run-1");
    expect(pendingChangeSet).not.toBeNull();

    await store.save({ ...chat, pendingChangeSet });

    expect((await store.get(chat.id))?.pendingChangeSet).toEqual(
      pendingChangeSet,
    );
  });
});
