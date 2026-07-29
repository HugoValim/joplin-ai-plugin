import type { RollbackRecord } from "../../src/agent/changeApplier";
import { JsonRollbackStore } from "../../src/persistence/rollbackStore";
import { MemoryJsonFilePort } from "../fakes/memoryJsonFilePort";

function record(runId: string, createdAt: number): RollbackRecord {
  return {
    runId,
    chatId: "chat-1",
    createdAt,
    items: [
      {
        kind: "file",
        changeId: "change-1",
        chatId: "chat-1",
        snapshot: {
          relativePath: "guide.md",
          bytesBase64: Buffer.from("original").toString("base64"),
          sha256: "original-hash",
          mode: 0o644,
        },
        expectedAppliedSha256: "applied-hash",
      },
    ],
  };
}

describe("JsonRollbackStore", () => {
  test("persists an exact rollback record", async () => {
    const files = new MemoryJsonFilePort();
    const store = new JsonRollbackStore("/plugin", files, () => 1_000);
    const input = record("run-1", 1_000);

    await store.save(input);

    expect(await store.get("run-1")).toEqual(input);
  });

  test("retains only the latest ten runs within seven days", async () => {
    const now = 8 * 24 * 60 * 60 * 1_000;
    const files = new MemoryJsonFilePort();
    const store = new JsonRollbackStore("/plugin", files, () => now);
    await store.save(record("expired", 0));
    for (let index = 0; index < 11; index += 1) {
      await store.save(record(`run-${index}`, now + index));
    }

    expect(await store.get("expired")).toBeNull();
    expect(await store.get("run-0")).toBeNull();
    expect(await store.get("run-10")).not.toBeNull();
    expect(files.removed).toEqual(
      expect.arrayContaining([
        "/plugin/rollbacks/expired.json",
        "/plugin/rollbacks/run-0.json",
      ]),
    );
  });
});
