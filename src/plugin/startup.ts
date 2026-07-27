import type Joplin from "api/Joplin";
import { ChangeApplier } from "../agent/changeApplier";
import { ContextBuilder } from "../agent/contextBuilder";
import {
  FastGlobCandidateFinder,
  JoplinFileSystemAdapter,
  WriteFileAtomicAdapter,
  type JoplinFsExtra,
} from "../fileWorkspace/adapters";
import { JoplinNoteRepository } from "../notes/joplinNoteRepository";
import { JoplinSemanticNoteSearch } from "../notes/joplinSemanticSearch";
import { NoteRetriever } from "../notes/retriever";
import { InMemoryChangeSetStore } from "../persistence/changeSetStore";
import {
  JoplinJsonFileAdapter,
  type PersistenceFsExtra,
} from "../persistence/adapters";
import { ChatStore } from "../persistence/chatStore";
import { JsonRollbackStore } from "../persistence/rollbackStore";
import { OpenAiCompatibleProvider } from "../providers/openAiProvider";
import { registerFileTools } from "../tools/fileTools";
import { registerNoteTools } from "../tools/noteTools";
import { ToolRegistry } from "../tools/toolRegistry";
import { ChatController } from "./chatController";
import {
  JoplinCommandAdapter,
  JoplinDataAdapter,
  JoplinDialogAdapter,
  JoplinSettingsAdapter,
} from "./joplinPorts";
import { JoplinPanelPort } from "./panelPort";
import { registerPluginSettings } from "./settings";
import {
  registerSelectionToChatShortcut,
  registerToggleSidebarShortcut,
} from "./shortcutCommands";
import {
  JoplinActiveNoteContextSource,
  PerChatWorkspaceResolver,
} from "./workspaceAdapters";
import { AssistantOutputActions } from "./assistantOutputActions";

type FsExtraBundle = JoplinFsExtra & PersistenceFsExtra;

/**
 * Composes plugin services against the Joplin desktop host.
 *
 * @example await startPlugin(joplin)
 */
export async function startPlugin(joplin: Joplin): Promise<void> {
  const settings = new JoplinSettingsAdapter(joplin);
  await registerPluginSettings(settings);
  const fsExtra = requireFsExtra(joplin);
  const fileSystem = new JoplinFileSystemAdapter(fsExtra);
  const jsonFiles = new JoplinJsonFileAdapter(fsExtra);
  const notes = new JoplinNoteRepository(new JoplinDataAdapter(joplin));
  const semantic = JoplinSemanticNoteSearch.create(optionalAi(joplin), notes);
  const retriever = new NoteRetriever(notes, semantic ?? undefined);
  const commands = new JoplinCommandAdapter(joplin);
  const activeSource = new JoplinActiveNoteContextSource(
    joplin.workspace,
    commands,
  );
  const contextBuilder = new ContextBuilder(
    activeSource,
    retriever,
    async (id) => {
      try {
        return await notes.readNote(id);
      } catch {
        return null;
      }
    },
  );
  const finder = new FastGlobCandidateFinder(fileSystem);
  const workspaces = new PerChatWorkspaceResolver(
    fileSystem,
    finder,
    new WriteFileAtomicAdapter(),
  );
  const changes = new InMemoryChangeSetStore();
  const tools = new ToolRegistry();
  registerNoteTools(tools, notes, changes);
  registerFileTools(tools, workspaces, changes);
  const dataDirectory = await joplin.plugins.dataDir();
  const chats = new ChatStore(dataDirectory, jsonFiles, structuredWarning);
  const applier = new ChangeApplier(
    changes,
    notes,
    workspaces,
    new JsonRollbackStore(dataDirectory, jsonFiles),
  );
  const dialogs = new JoplinDialogAdapter(joplin);
  const panel = new JoplinPanelPort(joplin.views.panels, structuredWarning);
  const controller = new ChatController(
    panel,
    chats,
    contextBuilder,
    tools,
    changes,
    applier,
    workspaces,
    settings,
    dialogs,
    commands,
    new AssistantOutputActions(chats, activeSource, notes, commands),
    (config) => new OpenAiCompatibleProvider(config),
  );
  await panel.initialize((request) => controller.handle(request));
  await registerToggleSidebarShortcut(
    joplin.commands,
    joplin.views.menuItems,
    panel,
  );
  await registerSelectionToChatShortcut(
    joplin.commands,
    joplin.views.menuItems,
    panel,
    activeSource,
  );
  controller.workspaceChanged(await activeNoteSummary(activeSource));
  await joplin.workspace.onNoteSelectionChange(() => {
    publishActiveNoteSummary(controller, activeSource);
  });
}

function publishActiveNoteSummary(
  controller: ChatController,
  source: JoplinActiveNoteContextSource,
): void {
  void activeNoteSummary(source).then(
    (note) => controller.workspaceChanged(note),
    structuredWarning,
  );
}

async function activeNoteSummary(
  source: JoplinActiveNoteContextSource,
): Promise<{ readonly id: string; readonly title: string } | null> {
  const note = await source.activeNote();
  return note ? { id: note.id, title: note.title } : null;
}

function requireFsExtra(joplin: Joplin): FsExtraBundle {
  const candidate: unknown = joplin.require("fs-extra");
  const methods = [
    "realpath",
    "stat",
    "readFile",
    "ensureDir",
    "rename",
    "remove",
  ];
  const valid =
    typeof candidate === "object" &&
    candidate !== null &&
    methods.every(
      (method) =>
        method in candidate &&
        typeof (candidate as Record<string, unknown>)[method] === "function",
    );
  if (valid) return candidate as FsExtraBundle;
  throw new Error(
    "Joplin fs-extra adapter is unavailable; expected native file methods",
  );
}

function optionalAi(joplin: Joplin): unknown {
  return (joplin as unknown as { readonly ai?: unknown }).ai;
}

function structuredWarning(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(JSON.stringify({ event: "joplin-ai-agent.warning", message }));
}
