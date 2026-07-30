import { randomUUID } from "crypto";
import path from "path";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DomainError, safeValue } from "../shared/errors";
import { ChangeSetSchema, type ChangeSet } from "./changeSetStore";

export interface JsonFilePort {
  ensureDirectory(path: string): Promise<void>;
  readText(path: string): Promise<string | null>;
  writeTextAtomic(path: string, content: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  removeFile(path: string): Promise<void>;
}

const IdentifierSchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^[A-Za-z0-9_-]+$",
});
const CitationSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("note"), Type.Literal("file")]),
    id: IdentifierSchema,
    label: Type.String({ minLength: 1, maxLength: 10_000 }),
    heading: Type.Optional(Type.String({ maxLength: 1_000 })),
    lineStart: Type.Optional(Type.Integer({ minimum: 1 })),
    lineEnd: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
const MessageSchema = Type.Object(
  {
    id: IdentifierSchema,
    role: Type.Union([
      Type.Literal("user"),
      Type.Literal("assistant"),
      Type.Literal("tool"),
    ]),
    content: Type.String({ maxLength: 1_000_000 }),
    createdAt: Type.Number({ minimum: 0 }),
    citations: Type.Optional(Type.Array(CitationSchema, { maxItems: 100 })),
  },
  { additionalProperties: false },
);
const ContextSchema = Type.Object(
  {
    activeNote: Type.Boolean(),
    vault: Type.Boolean(),
    autoApply: Type.Optional(Type.Boolean()),
    interactionMode: Type.Optional(
      Type.Union([Type.Literal("ask"), Type.Literal("agent")]),
    ),
    attachedNoteIds: Type.Array(IdentifierSchema, {
      maxItems: 50,
      uniqueItems: true,
    }),
    attachedNotebookIds: Type.Optional(
      Type.Array(IdentifierSchema, {
        maxItems: 20,
        uniqueItems: true,
      }),
    ),
  },
  { additionalProperties: false },
);
const RunSummarySchema = Type.Object(
  {
    runId: IdentifierSchema,
    status: Type.Union([
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("cancelled"),
      Type.Literal("awaiting-approval"),
      Type.Literal("applied"),
      Type.Literal("denied"),
    ]),
    summary: Type.String({ maxLength: 10_000 }),
    completedAt: Type.Number({ minimum: 0 }),
    promptTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    outputTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    totalTokens: Type.Optional(Type.Integer({ minimum: 0 })),
    toolNames: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
        maxItems: 100,
      }),
    ),
  },
  { additionalProperties: false },
);
const ChatSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    id: IdentifierSchema,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    createdAt: Type.Number({ minimum: 0 }),
    updatedAt: Type.Number({ minimum: 0 }),
    messages: Type.Array(MessageSchema, { maxItems: 10_000 }),
    context: ContextSchema,
    externalRoot: Type.Union([
      Type.String({ minLength: 1, maxLength: 10_000 }),
      Type.Null(),
    ]),
    references: Type.Array(CitationSchema, { maxItems: 1_000 }),
    runSummaries: Type.Array(RunSummarySchema, { maxItems: 1_000 }),
    pendingChangeSet: Type.Union([ChangeSetSchema, Type.Null()]),
    parkedAppliedChangeSet: Type.Optional(
      Type.Union([ChangeSetSchema, Type.Null()]),
    ),
  },
  { additionalProperties: false },
);
const ChatSummarySchema = Type.Object(
  {
    id: IdentifierSchema,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    updatedAt: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);
const IndexSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    chats: Type.Array(ChatSummarySchema, { maxItems: 10_000 }),
  },
  { additionalProperties: false },
);

type StoredChatShape = Static<typeof ChatSchema>;
type StoredContext = StoredChatShape["context"];
export type PersistedChat = Omit<
  StoredChatShape,
  "context" | "pendingChangeSet" | "parkedAppliedChangeSet"
> & {
  readonly context: Omit<StoredContext, "autoApply" | "interactionMode"> & {
    readonly autoApply: boolean;
    readonly interactionMode: "ask" | "agent";
  };
  readonly pendingChangeSet: ChangeSet | null;
  readonly parkedAppliedChangeSet: ChangeSet | null;
};
export type PersistedChatMessage = Static<typeof MessageSchema>;
export type PersistedChatSummary = Static<typeof ChatSummarySchema>;
export type PersistedRunSummary = Static<typeof RunSummarySchema>;
export type PersistedCitation = Static<typeof CitationSchema>;

type CorruptionReporter = (message: string) => void;

export class ChatStore {
  private readonly chatsDirectory: string;
  private readonly indexPath: string;

  public constructor(
    private readonly dataDirectory: string,
    private readonly files: JsonFilePort,
    private readonly reportCorruption: CorruptionReporter = () => undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.chatsDirectory = path.join(dataDirectory, "chats");
    this.indexPath = path.join(this.chatsDirectory, "index.json");
  }

  /**
   * Creates and atomically indexes an empty local-only chat.
   *
   * @example await store.create('New chat')
   */
  public async create(title = "New chat"): Promise<PersistedChat> {
    await this.initialize();
    const timestamp = this.now();
    const chat: PersistedChat = {
      schemaVersion: 1,
      id: randomUUID(),
      title: title.trim() || "New chat",
      createdAt: timestamp,
      updatedAt: timestamp,
      messages: [],
      context: {
        activeNote: true,
        vault: false,
        autoApply: false,
        interactionMode: "agent",
        attachedNoteIds: [],
        attachedNotebookIds: [],
      },
      externalRoot: null,
      references: [],
      runSummaries: [],
      pendingChangeSet: null,
      parkedAppliedChangeSet: null,
    };
    await this.save(chat);
    return chat;
  }

  /**
   * Loads one chat, quarantining only that record when corrupt.
   *
   * @example await store.get(chatId)
   */
  public async get(chatId: string): Promise<PersistedChat | null> {
    assertIdentifier(chatId);
    const chatPath = this.chatPath(chatId);
    const content = await this.files.readText(chatPath);
    if (content === null) {
      await this.removeIndexEntry(chatId);
      return null;
    }
    const stored = await this.parseOrQuarantine(
      ChatSchema,
      content,
      chatPath,
      chatId,
    );
    const chat = stored ? normalizeStoredChat(stored) : null;
    if (chat && isConsistentChat(chat, chatId)) return chat;
    if (chat) {
      await this.quarantine(
        chatPath,
        chatId,
        new Error("chat/change-set ownership validation failed"),
      );
    }
    await this.removeIndexEntry(chatId);
    return null;
  }

  /**
   * Lists chat switcher metadata, newest first.
   *
   * @example await store.list()
   */
  public async list(): Promise<readonly PersistedChatSummary[]> {
    await this.initialize();
    const index = await this.readIndex();
    return [...index.chats].sort(
      (left, right) => right.updatedAt - left.updatedAt,
    );
  }

  /**
   * Atomically saves a schema-v1 chat and refreshes its index entry.
   *
   * @example await store.save({ ...chat, messages })
   */
  public async save(chat: PersistedChat): Promise<void> {
    assertSchema(ChatSchema, chat, "a schema-v1 chat");
    assertConsistentChat(chat);
    await this.initialize();
    await this.files.writeTextAtomic(this.chatPath(chat.id), stringify(chat));
    const index = await this.readIndex();
    const chats = index.chats.filter((entry) => entry.id !== chat.id);
    chats.push({ id: chat.id, title: chat.title, updatedAt: chat.updatedAt });
    await this.writeIndex(chats);
  }

  /**
   * Removes one local chat record and its index entry.
   *
   * @example await store.delete(chatId)
   */
  public async delete(chatId: string): Promise<void> {
    assertIdentifier(chatId);
    await this.files.removeFile(this.chatPath(chatId));
    const index = await this.readIndex();
    await this.writeIndex(index.chats.filter((entry) => entry.id !== chatId));
  }

  /**
   * Clears transcript/run data while retaining the chat context selection.
   *
   * @example await store.clear(chatId)
   */
  public async clear(chatId: string): Promise<PersistedChat> {
    const chat = await this.get(chatId);
    if (!chat) throw unknownChat(chatId);
    const cleared: PersistedChat = {
      ...chat,
      updatedAt: this.now(),
      messages: [],
      references: [],
      runSummaries: [],
      pendingChangeSet: null,
      parkedAppliedChangeSet: null,
    };
    await this.save(cleared);
    return cleared;
  }

  private initialize(): Promise<void> {
    return this.files.ensureDirectory(this.chatsDirectory);
  }

  private async readIndex(): Promise<Static<typeof IndexSchema>> {
    const content = await this.files.readText(this.indexPath);
    if (content === null) return { schemaVersion: 1, chats: [] };
    const parsed = await this.parseOrQuarantine(
      IndexSchema,
      content,
      this.indexPath,
      "index",
    );
    return parsed ?? { schemaVersion: 1, chats: [] };
  }

  private writeIndex(chats: readonly PersistedChatSummary[]): Promise<void> {
    return this.files.writeTextAtomic(
      this.indexPath,
      stringify({ schemaVersion: 1, chats }),
    );
  }

  private async removeIndexEntry(chatId: string): Promise<void> {
    const index = await this.readIndex();
    const retained = index.chats.filter((entry) => entry.id !== chatId);
    if (retained.length === index.chats.length) return;
    await this.writeIndex(retained);
  }

  private chatPath(chatId: string): string {
    return path.join(this.chatsDirectory, `${chatId}.json`);
  }

  private async parseOrQuarantine<T extends TSchema>(
    schema: T,
    content: string,
    recordPath: string,
    label: string,
  ): Promise<Static<T> | null> {
    try {
      const parsed: unknown = JSON.parse(content);
      if (Value.Check(schema, parsed)) return parsed;
      throw new Error("schema validation failed");
    } catch (error: unknown) {
      await this.quarantine(recordPath, label, error);
      return null;
    }
  }

  private async quarantine(
    recordPath: string,
    label: string,
    error: unknown,
  ): Promise<void> {
    const destination = `${recordPath}.corrupt-${this.now()}`;
    await this.files.rename(recordPath, destination);
    const reason = error instanceof Error ? error.message : safeValue(error);
    this.reportCorruption(
      `Quarantined corrupt chat record ${label}: ${reason.slice(0, 500)}`,
    );
  }
}

function stringify(input: unknown): string {
  return `${JSON.stringify(input, null, 2)}\n`;
}

function normalizeStoredChat(chat: StoredChatShape): PersistedChat {
  return {
    ...chat,
    context: {
      ...chat.context,
      autoApply: chat.context.autoApply ?? false,
      interactionMode: chat.context.interactionMode ?? "agent",
      attachedNotebookIds: chat.context.attachedNotebookIds ?? [],
    },
    parkedAppliedChangeSet: chat.parkedAppliedChangeSet ?? null,
  };
}

function assertSchema(schema: TSchema, input: unknown, expected: string): void {
  if (Value.Check(schema, input)) return;
  throw new DomainError(
    "VALIDATION",
    `Invalid persisted value ${safeValue(input)}; expected ${expected}`,
  );
}

function assertIdentifier(chatId: string): void {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(chatId)) return;
  throw new DomainError(
    "VALIDATION",
    `Invalid chat ID ${safeValue(chatId)}; expected 1..128 identifier characters`,
  );
}

function unknownChat(chatId: string): DomainError {
  return new DomainError(
    "NOT_AVAILABLE",
    `Unknown chat ${safeValue(chatId)}; expected an existing chat ID`,
  );
}

function isConsistentChat(chat: PersistedChat, expectedId: string): boolean {
  return (
    chat.id === expectedId &&
    isConsistentPending(chat.pendingChangeSet, chat.id) &&
    isConsistentParked(chat.parkedAppliedChangeSet, chat.id)
  );
}

function isConsistentPending(
  pending: ChangeSet | null,
  chatId: string,
): boolean {
  if (!pending) return true;
  return (
    pending.chatId === chatId &&
    (pending.status === "proposed" ||
      pending.status === "applied" ||
      pending.status === "partial")
  );
}

function isConsistentParked(parked: ChangeSet | null, chatId: string): boolean {
  if (!parked) return true;
  return (
    parked.chatId === chatId &&
    (parked.status === "applied" || parked.status === "partial")
  );
}

function assertConsistentChat(chat: PersistedChat): void {
  if (isConsistentChat(chat, chat.id)) return;
  throw new DomainError(
    "VALIDATION",
    `Invalid chat ${chat.id} pending change-set ownership; expected matching chat ID and proposed, applied, or partial status`,
  );
}
