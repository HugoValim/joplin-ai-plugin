import type { SettingItem, SettingSection } from "../../api/types";
import {
  registerPluginSettings,
  type SettingsPort,
} from "../../src/plugin/settings";

class RecordingSettingsPort implements SettingsPort {
  public readonly sections = new Map<string, SettingSection>();
  public readonly settings = new Map<string, SettingItem>();

  public async registerSection(
    name: string,
    section: SettingSection,
  ): Promise<void> {
    this.sections.set(name, section);
    return Promise.resolve();
  }

  public async registerSettings(
    settings: Record<string, SettingItem>,
  ): Promise<void> {
    Object.entries(settings).forEach(([key, value]) =>
      this.settings.set(key, value),
    );
    return Promise.resolve();
  }

  public async values(keys: string[]): Promise<Record<string, unknown>> {
    const values: Record<string, unknown> = {};
    for (const key of keys) values[key] = undefined;
    return Promise.resolve(values);
  }

  public async setValue(key: string, value: unknown): Promise<void> {
    const setting = this.settings.get(key);
    if (!setting)
      throw new Error(`Unknown setting ${key}; expected registered`);
    this.settings.set(key, { ...setting, value });
  }
}

describe("plugin settings", () => {
  test("registers a useful and conservative default note-writing prompt", async () => {
    const port = new RecordingSettingsPort();

    await registerPluginSettings(port);

    const prompt: unknown = port.settings.get(
      "joplinAiAgent.systemPrompt",
    )?.value;
    if (typeof prompt !== "string") {
      throw new Error(`Invalid prompt ${String(prompt)}; expected a string`);
    }
    expect(prompt).toMatch(/preserve/i);
    expect(prompt).toContain("Do not invent");
    expect(prompt).toContain("Markdown");
    expect(prompt).toContain("clarifying question");
    expect(prompt).toContain("start_subagent");
    expect(prompt).toMatch(/up to 3/i);
    expect(prompt).not.toContain("\n");
  });
});
