import {
  AppType,
  SettingItemType,
  type SettingItem,
  type SettingSection,
} from "api/types";
import type { ProviderConfig } from "../providers/types";
import { DomainError, safeValue } from "../shared/errors";

const SECTION = "joplinAiAgent";
const DEFAULT_SYSTEM_PROMPT = [
  "Be a careful writing partner for Joplin notes.",
  "Preserve the user's meaning, voice, language, factual uncertainty, and useful detail.",
  "Do not invent facts or sources. Keep valid Markdown, links, tasks, code, and front matter intact unless asked to change them.",
  "Prefer focused, minimal edits and clear, concise prose.",
  "Ask one clarifying question when ambiguity could materially change the result.",
].join(" ");
const KEYS = {
  baseUrl: "joplinAiAgent.baseUrl",
  apiKey: "joplinAiAgent.apiKey",
  model: "joplinAiAgent.model",
  systemPrompt: "joplinAiAgent.systemPrompt",
  temperature: "joplinAiAgent.temperature",
  maxOutputTokens: "joplinAiAgent.maxOutputTokens",
  timeoutMs: "joplinAiAgent.timeoutMs",
  allowInsecureRemote: "joplinAiAgent.allowInsecureRemote",
} as const;

export interface SettingsPort {
  registerSection(name: string, section: SettingSection): Promise<void>;
  registerSettings(settings: Record<string, SettingItem>): Promise<void>;
  values(keys: string[]): Promise<Record<string, unknown>>;
  setValue(key: string, value: unknown): Promise<void>;
}

/**
 * Registers the single endpoint and privacy/security settings.
 *
 * @example await registerPluginSettings(joplin.settings)
 */
export async function registerPluginSettings(
  port: SettingsPort,
): Promise<void> {
  await port.registerSection(SECTION, {
    label: "Joplin AI Agent",
    iconName: "fas fa-wand-magic-sparkles",
    description: "Provider data is sent only for context enabled in each chat.",
  });
  await port.registerSettings(settingDefinitions());
}

/**
 * Reads provider settings while keeping the secure API key in the plugin process.
 *
 * @example await loadProviderConfig(joplin.settings)
 */
export async function loadProviderConfig(
  port: SettingsPort,
): Promise<ProviderConfig> {
  const values = await port.values(Object.values(KEYS));
  return {
    baseUrl: readString(values, KEYS.baseUrl),
    apiKey: readString(values, KEYS.apiKey),
    model: readString(values, KEYS.model),
    temperature: readTemperature(values),
    maxOutputTokens: readInteger(values, KEYS.maxOutputTokens, 1, 100_000),
    timeoutMs: readInteger(values, KEYS.timeoutMs, 1_000, 600_000),
    allowInsecureRemote: readBoolean(values, KEYS.allowInsecureRemote),
  };
}

/**
 * Reads the user-owned system prompt separately from transport configuration.
 *
 * @example await loadSystemPrompt(joplin.settings)
 */
export async function loadSystemPrompt(port: SettingsPort): Promise<string> {
  const values = await port.values([KEYS.systemPrompt]);
  return readString(values, KEYS.systemPrompt);
}

/**
 * Records the user's explicit remote-HTTP security confirmation.
 *
 * @example await allowConfirmedRemoteHttp(joplin.settings)
 */
export function allowConfirmedRemoteHttp(port: SettingsPort): Promise<void> {
  return port.setValue(KEYS.allowInsecureRemote, true);
}

function settingDefinitions(): Record<string, SettingItem> {
  return {
    [KEYS.baseUrl]: stringSetting(
      "Base URL",
      "http://localhost:11434/v1",
      "OpenAI-compatible HTTP(S) endpoint.",
    ),
    [KEYS.apiKey]: {
      ...stringSetting(
        "API key",
        "",
        "Stored securely and never sent to the sidebar.",
      ),
      secure: true,
    },
    [KEYS.model]: stringSetting("Model", "", "Required model name."),
    [KEYS.systemPrompt]: stringSetting(
      "System prompt",
      DEFAULT_SYSTEM_PROMPT,
      "Custom instructions appended after fixed safety rules.",
    ),
    [KEYS.temperature]: stringSetting(
      "Temperature",
      "0.2",
      "Decimal from 0 to 2.",
    ),
    [KEYS.maxOutputTokens]: integerSetting(
      "Maximum output tokens",
      2_000,
      1,
      100_000,
    ),
    [KEYS.timeoutMs]: integerSetting(
      "Request timeout (milliseconds)",
      120_000,
      1_000,
      600_000,
    ),
    [KEYS.allowInsecureRemote]: {
      value: false,
      type: SettingItemType.Bool,
      label: "Allow confirmed remote HTTP endpoint",
      description:
        "Security risk: content and credentials can be intercepted. Prefer HTTPS.",
      public: true,
      section: SECTION,
      appTypes: [AppType.Desktop],
      advanced: true,
    },
  };
}

function stringSetting(
  label: string,
  value: string,
  description: string,
): SettingItem {
  return {
    value,
    type: SettingItemType.String,
    label,
    description,
    public: true,
    section: SECTION,
    appTypes: [AppType.Desktop],
  };
}

function integerSetting(
  label: string,
  value: number,
  minimum: number,
  maximum: number,
): SettingItem {
  return {
    value,
    type: SettingItemType.Int,
    label,
    public: true,
    section: SECTION,
    appTypes: [AppType.Desktop],
    minimum,
    maximum,
    step: 1,
  };
}

function readString(values: Record<string, unknown>, key: string): string {
  const value = values[key];
  if (typeof value === "string") return value;
  throw invalidSetting(key, value, "a string");
}

function readBoolean(values: Record<string, unknown>, key: string): boolean {
  const value = values[key];
  if (typeof value === "boolean") return value;
  throw invalidSetting(key, value, "a boolean");
}

function readTemperature(values: Record<string, unknown>): number {
  const encoded = readString(values, KEYS.temperature);
  const temperature = Number(encoded);
  if (Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) {
    return temperature;
  }
  throw invalidSetting(KEYS.temperature, encoded, "a decimal from 0 to 2");
}

function readInteger(
  values: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const value = values[key];
  if (
    Number.isInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum
  ) {
    return Number(value);
  }
  throw invalidSetting(key, value, `an integer from ${minimum} to ${maximum}`);
}

function invalidSetting(
  key: string,
  value: unknown,
  expected: string,
): DomainError {
  return new DomainError(
    "VALIDATION",
    `Invalid setting ${key}=${safeValue(value)}; expected ${expected}`,
  );
}
