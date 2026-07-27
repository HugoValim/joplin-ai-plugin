import type Joplin from "api/Joplin";
import type { SettingItem, SettingSection } from "api/types";
import type { JoplinDataPort } from "../notes/joplinNoteRepository";
import type { SettingsPort } from "./settings";
import type { CommandPort, DialogPort } from "./types";

export class JoplinSettingsAdapter implements SettingsPort {
  public constructor(private readonly joplin: Joplin) {}

  public registerSection(name: string, section: SettingSection): Promise<void> {
    return this.joplin.settings.registerSection(name, section);
  }

  public registerSettings(
    settings: Record<string, SettingItem>,
  ): Promise<void> {
    return this.joplin.settings.registerSettings(settings);
  }

  public async values(keys: string[]): Promise<Record<string, unknown>> {
    const input: unknown = await this.joplin.settings.values(keys);
    if (typeof input === "object" && input !== null) {
      return input as Record<string, unknown>;
    }
    throw new Error("Joplin settings returned a non-object value");
  }

  public setValue(key: string, value: unknown): Promise<void> {
    return this.joplin.settings.setValue(key, value);
  }
}

export class JoplinDataAdapter implements JoplinDataPort {
  public constructor(private readonly joplin: Joplin) {}

  public async get(
    path: string[],
    query?: Record<string, unknown>,
  ): Promise<unknown> {
    return (await this.joplin.data.get(path, query)) as unknown;
  }

  public async post(
    path: string[],
    query?: Record<string, unknown> | null,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    return (await this.joplin.data.post(path, query, body)) as unknown;
  }

  public async put(
    path: string[],
    query?: Record<string, unknown> | null,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    return (await this.joplin.data.put(path, query, body)) as unknown;
  }

  /**
   * Delegates recoverable item deletion to Joplin's Data API.
   *
   * @example await adapter.delete(['notes', noteId])
   */
  public async delete(
    path: string[],
    query?: Record<string, unknown>,
  ): Promise<unknown> {
    return (await this.joplin.data.delete(path, query)) as unknown;
  }
}

export class JoplinDialogAdapter implements DialogPort {
  public constructor(private readonly joplin: Joplin) {}

  public showOpenDialog(options: {
    readonly title: string;
    readonly properties: readonly string[];
  }): Promise<readonly string[] | null> {
    return this.joplin.views.dialogs.showOpenDialog({
      title: options.title,
      properties: ["openDirectory", "createDirectory"],
    });
  }

  public showMessageBox(message: string): Promise<number> {
    return this.joplin.views.dialogs.showMessageBox(message);
  }
}

export class JoplinCommandAdapter implements CommandPort {
  public constructor(private readonly joplin: Joplin) {}

  public async execute(
    commandName: string,
    ...args: unknown[]
  ): Promise<unknown> {
    return (await this.joplin.commands.execute(
      commandName,
      ...args,
    )) as unknown;
  }
}
