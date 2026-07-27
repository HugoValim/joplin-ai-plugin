import type { ActiveNoteSummary, SidebarSnapshot } from "./sidebarState";

type ActiveChat = NonNullable<SidebarSnapshot["activeChat"]>;

interface ContextSummaryProps {
  readonly chat: ActiveChat;
  readonly activeNote: ActiveNoteSummary;
  readonly disabled: boolean;
  readonly onUpdate: (next: Partial<ActiveChat["context"]>) => void;
  readonly onToggleAttached: () => void;
  readonly onSelectFolder: () => void;
}

/**
 * Shows collapsed context chips with a native expanded disclosure.
 *
 * @example <ContextSummary chat={chat} activeNote={note} {...actions} />
 */
export function ContextSummary(props: ContextSummaryProps): JSX.Element {
  const attached = props.chat.context.attachedNoteIds.length;
  return (
    <details className="context-summary">
      <summary aria-label="Context settings">
        <ContextChip
          label={props.activeNote?.title ?? "No active note"}
          title={props.activeNote?.title}
        />
        <ContextChip label={`${attached} attached`} />
        <ContextChip
          label={`Vault ${props.chat.context.vault ? "on" : "off"}`}
        />
        <ContextChip
          label={props.chat.context.autoApply ? "Writes auto" : "Writes review"}
        />
        <ContextChip
          label={props.chat.externalRoot ?? "Add folder"}
          title={props.chat.externalRoot ?? undefined}
        />
      </summary>
      <div className="context-details">
        <ContextToggle
          label="Active Note"
          description="Include a fresh snapshot of the selected note for each turn."
          checked={props.chat.context.activeNote}
          disabled={props.disabled}
          onChange={(checked) => props.onUpdate({ activeNote: checked })}
        />
        <div className="context-control">
          <div>
            <strong>Attached notes</strong>
            <p>Attachments persist in this chat until detached.</p>
          </div>
          <button
            type="button"
            disabled={!props.activeNote || props.disabled}
            aria-pressed={isActiveNoteAttached(props)}
            onClick={props.onToggleAttached}
          >
            {isActiveNoteAttached(props) ? "Detach current" : "Attach current"}
          </button>
        </div>
        <ContextToggle
          label="Vault RAG"
          description="Search note snippets relevant to each prompt."
          checked={props.chat.context.vault}
          disabled={props.disabled}
          onChange={(checked) => props.onUpdate({ vault: checked })}
        />
        <ContextToggle
          label="Auto-apply changes"
          description="Apply non-delete model proposals without review. Deletions still require manual review."
          checked={props.chat.context.autoApply}
          disabled={props.disabled}
          onChange={(checked) => props.onUpdate({ autoApply: checked })}
        />
        <div className="context-control">
          <div>
            <strong>Folder scope</strong>
            <p title={props.chat.externalRoot ?? undefined}>
              {props.chat.externalRoot ?? "No external text folder selected."}
            </p>
          </div>
          <button
            type="button"
            disabled={props.disabled}
            onClick={props.onSelectFolder}
          >
            {props.chat.externalRoot ? "Change folder" : "Add folder"}
          </button>
        </div>
      </div>
    </details>
  );
}

function ContextChip({
  label,
  title,
}: {
  readonly label: string;
  readonly title?: string;
}): JSX.Element {
  return (
    <span className="context-chip" title={title}>
      {label}
    </span>
  );
}

function ContextToggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly description: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <label className="context-control">
      <span>
        <strong>{label}</strong>
        <p>{description}</p>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function isActiveNoteAttached(props: ContextSummaryProps): boolean {
  return Boolean(
    props.activeNote &&
    props.chat.context.attachedNoteIds.includes(props.activeNote.id),
  );
}
