import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DomainError, safeValue } from "./errors";

export const PROTOCOL_VERSION = 1 as const;

const IdentifierSchema = Type.String({ minLength: 1, maxLength: 128 });
const EmptyPayloadSchema = Type.Object({}, { additionalProperties: false });
const EnvelopeProperties = {
  version: Type.Literal(PROTOCOL_VERSION),
  messageId: IdentifierSchema,
  chatId: IdentifierSchema,
};
const RunEnvelopeProperties = {
  ...EnvelopeProperties,
  runId: IdentifierSchema,
};

const ChatSubmitSchema = Type.Object(
  {
    ...RunEnvelopeProperties,
    type: Type.Literal("chat.submit"),
    payload: Type.Object(
      { text: Type.String({ minLength: 1, maxLength: 100_000 }) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const PanelReadySchema = Type.Object(
  {
    ...EnvelopeProperties,
    type: Type.Literal("panel.ready"),
    payload: EmptyPayloadSchema,
  },
  { additionalProperties: false },
);

const ChatCreateSchema = Type.Object(
  {
    ...EnvelopeProperties,
    type: Type.Literal("chat.create"),
    payload: Type.Object(
      { title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ChatSelectSchema = Type.Object(
  {
    ...EnvelopeProperties,
    type: Type.Literal("chat.select"),
    payload: EmptyPayloadSchema,
  },
  { additionalProperties: false },
);

const ChatMaintenanceSchema = Type.Object(
  {
    ...EnvelopeProperties,
    type: Type.Union([Type.Literal("chat.clear"), Type.Literal("chat.delete")]),
    payload: EmptyPayloadSchema,
  },
  { additionalProperties: false },
);

const RunCancelSchema = Type.Object(
  {
    ...RunEnvelopeProperties,
    type: Type.Literal("run.cancel"),
    payload: EmptyPayloadSchema,
  },
  { additionalProperties: false },
);

const ContextUpdateSchema = Type.Object(
  {
    ...EnvelopeProperties,
    type: Type.Literal("context.update"),
    payload: Type.Object(
      {
        activeNote: Type.Boolean(),
        vault: Type.Boolean(),
        attachedNoteIds: Type.Array(IdentifierSchema, {
          maxItems: 50,
          uniqueItems: true,
        }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const FolderSelectSchema = Type.Object(
  {
    ...EnvelopeProperties,
    type: Type.Literal("folder.select"),
    payload: EmptyPayloadSchema,
  },
  { additionalProperties: false },
);

const ChangesApplySchema = Type.Object(
  {
    ...RunEnvelopeProperties,
    type: Type.Literal("changes.apply"),
    payload: Type.Object(
      {
        changeSetId: IdentifierSchema,
        acceptedIds: Type.Array(IdentifierSchema, {
          maxItems: 50,
          uniqueItems: true,
        }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ChangesDiscardSchema = Type.Object(
  {
    ...RunEnvelopeProperties,
    type: Type.Literal("changes.discard"),
    payload: Type.Object(
      { changeSetId: IdentifierSchema },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const RunUndoSchema = Type.Object(
  {
    ...RunEnvelopeProperties,
    type: Type.Literal("run.undo"),
    payload: Type.Object(
      { targetRunId: IdentifierSchema },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const NoteOpenSchema = Type.Object(
  {
    ...EnvelopeProperties,
    type: Type.Literal("note.open"),
    payload: Type.Object(
      { noteId: IdentifierSchema },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const AssistantActionSchema = Type.Object(
  {
    ...RunEnvelopeProperties,
    type: Type.Literal("assistant.action"),
    payload: Type.Object(
      {
        messageId: IdentifierSchema,
        action: Type.Union([
          Type.Literal("insert-at-cursor"),
          Type.Literal("replace-selection"),
          Type.Literal("append-to-note"),
          Type.Literal("create-note"),
        ]),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const PanelRequestSchema = Type.Union([
  PanelReadySchema,
  ChatCreateSchema,
  ChatSelectSchema,
  ChatMaintenanceSchema,
  ChatSubmitSchema,
  RunCancelSchema,
  ContextUpdateSchema,
  FolderSelectSchema,
  ChangesApplySchema,
  ChangesDiscardSchema,
  RunUndoSchema,
  NoteOpenSchema,
  AssistantActionSchema,
]);

export type PanelRequest = Static<typeof PanelRequestSchema>;

const CitationSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("note"), Type.Literal("file")]),
    id: IdentifierSchema,
    label: Type.String({ minLength: 1, maxLength: 500 }),
    heading: Type.Optional(Type.String({ maxLength: 500 })),
    lineStart: Type.Optional(Type.Integer({ minimum: 1 })),
    lineEnd: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

const ChatMessageSchema = Type.Object(
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

const ContextSettingsSchema = Type.Object(
  {
    activeNote: Type.Boolean(),
    vault: Type.Boolean(),
    attachedNoteIds: Type.Array(IdentifierSchema, {
      maxItems: 50,
      uniqueItems: true,
    }),
  },
  { additionalProperties: false },
);

const ChangeViewSchema = Type.Object(
  {
    id: IdentifierSchema,
    kind: Type.Union([Type.Literal("note"), Type.Literal("file")]),
    targetId: IdentifierSchema,
    targetLabel: Type.String({ minLength: 1, maxLength: 1_000 }),
    before: Type.String({ maxLength: 2_000_000 }),
    after: Type.String({ maxLength: 2_000_000 }),
    diff: Type.String({ maxLength: 4_000_000 }),
    status: Type.Union([
      Type.Literal("proposed"),
      Type.Literal("applied"),
      Type.Literal("conflict"),
      Type.Literal("skipped"),
    ]),
    message: Type.Optional(Type.String({ maxLength: 1_000 })),
  },
  { additionalProperties: false },
);

const ChangeSetViewSchema = Type.Object(
  {
    changeSetId: IdentifierSchema,
    runId: Type.Optional(IdentifierSchema),
    changes: Type.Array(ChangeViewSchema, { maxItems: 50 }),
  },
  { additionalProperties: false },
);

const ActiveChatSchema = Type.Object(
  {
    id: IdentifierSchema,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    messages: Type.Array(ChatMessageSchema, { maxItems: 10_000 }),
    context: ContextSettingsSchema,
    externalRoot: Type.Union([
      Type.String({ minLength: 1, maxLength: 10_000 }),
      Type.Null(),
    ]),
    pendingChangeSet: Type.Union([ChangeSetViewSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

const StateSnapshotSchema = Type.Object(
  {
    ...EnvelopeProperties,
    type: Type.Literal("state.snapshot"),
    payload: Type.Object(
      {
        chats: Type.Array(
          Type.Object(
            {
              id: IdentifierSchema,
              title: Type.String({ minLength: 1, maxLength: 200 }),
              updatedAt: Type.Number({ minimum: 0 }),
            },
            { additionalProperties: false },
          ),
          { maxItems: 10_000 },
        ),
        activeChat: Type.Union([ActiveChatSchema, Type.Null()]),
        endpointStatus: Type.Union([
          Type.Literal("unconfigured"),
          Type.Literal("checking"),
          Type.Literal("online"),
          Type.Literal("offline"),
        ]),
        modelName: Type.String({ maxLength: 500 }),
        privacyNotice: Type.String({ minLength: 1, maxLength: 2_000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const WorkspaceChangedSchema = Type.Object(
  {
    ...EnvelopeProperties,
    type: Type.Literal("workspace.changed"),
    payload: Type.Object(
      { activeNoteId: Type.Union([IdentifierSchema, Type.Null()]) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const RunStartedSchema = Type.Object(
  {
    ...RunEnvelopeProperties,
    type: Type.Literal("run.started"),
    payload: Type.Object(
      { startedAt: Type.Number({ minimum: 0 }) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const AssistantDeltaSchema = Type.Object(
  {
    ...RunEnvelopeProperties,
    type: Type.Literal("assistant.delta"),
    payload: Type.Object(
      { delta: Type.String({ minLength: 1, maxLength: 100_000 }) },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ToolStartedSchema = Type.Object(
  {
    ...RunEnvelopeProperties,
    type: Type.Literal("tool.started"),
    payload: Type.Object(
      { toolCallId: IdentifierSchema, name: IdentifierSchema },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ToolCompletedSchema = Type.Object(
  {
    ...RunEnvelopeProperties,
    type: Type.Literal("tool.completed"),
    payload: Type.Object(
      {
        toolCallId: IdentifierSchema,
        name: IdentifierSchema,
        ok: Type.Boolean(),
        summary: Type.String({ maxLength: 10_000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const ChangesProposedSchema = Type.Object(
  {
    ...RunEnvelopeProperties,
    type: Type.Literal("changes.proposed"),
    payload: ChangeSetViewSchema,
  },
  { additionalProperties: false },
);

const RunProgressSchema = Type.Object(
  {
    ...RunEnvelopeProperties,
    type: Type.Literal("run.progress"),
    payload: Type.Object(
      {
        current: Type.Integer({ minimum: 0 }),
        total: Type.Integer({ minimum: 0 }),
        label: Type.String({ minLength: 1, maxLength: 1_000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const RunFailedSchema = Type.Object(
  {
    ...RunEnvelopeProperties,
    type: Type.Literal("run.failed"),
    payload: Type.Object(
      {
        code: Type.String({ minLength: 1, maxLength: 100 }),
        message: Type.String({ minLength: 1, maxLength: 10_000 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const RunCompletedSchema = Type.Object(
  {
    ...RunEnvelopeProperties,
    type: Type.Literal("run.completed"),
    payload: Type.Object(
      {
        summary: Type.String({ maxLength: 10_000 }),
        undoRunId: Type.Optional(IdentifierSchema),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const PluginEventSchema = Type.Union([
  StateSnapshotSchema,
  WorkspaceChangedSchema,
  RunStartedSchema,
  AssistantDeltaSchema,
  ToolStartedSchema,
  ToolCompletedSchema,
  ChangesProposedSchema,
  RunProgressSchema,
  RunFailedSchema,
  RunCompletedSchema,
]);

export type PluginEvent = Static<typeof PluginEventSchema>;
export type ActiveChatView = Static<typeof ActiveChatSchema>;
export type ChangeSetView = Static<typeof ChangeSetViewSchema>;

/**
 * Validates a message received from the untrusted sidebar webview.
 *
 * @example parsePanelRequest({ version: 1, messageId: 'm', chatId: 'c',
 * runId: 'r', type: 'chat.submit', payload: { text: 'Hello' } })
 */
export function parsePanelRequest(input: unknown): PanelRequest {
  if (Value.Check(PanelRequestSchema, input)) return input;

  throw new DomainError(
    "VALIDATION",
    `Invalid panel message ${safeValue(input)}; expected a protocol v1 panel request`,
  );
}

/**
 * Validates a message received from the plugin process by the sidebar.
 *
 * @example parsePluginEvent({ version: 1, messageId: 'm', chatId: 'c',
 * type: 'workspace.changed', payload: { activeNoteId: null } })
 */
export function parsePluginEvent(input: unknown): PluginEvent {
  if (Value.Check(PluginEventSchema, input)) return input;

  throw new DomainError(
    "VALIDATION",
    `Invalid plugin message ${safeValue(input)}; expected a protocol v1 plugin event`,
  );
}
