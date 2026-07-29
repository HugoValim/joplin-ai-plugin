import { createParser, type ParseError } from "eventsource-parser";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DomainError, safeValue } from "../shared/errors";
import { validateProviderConfig } from "./endpoint";
import type {
  AiProvider,
  HttpTransport,
  NormalizedToolCall,
  ProviderConfig,
  ProviderEvent,
  StreamChatRequest,
} from "./types";

export type {
  AiProvider,
  HttpTransport,
  NormalizedToolCall,
  ProviderConfig,
  ProviderEvent,
  StreamChatRequest,
} from "./types";

const MAX_SSE_EVENT_CHARS = 1_048_576;
const MAX_TOTAL_SSE_BYTES = 16 * 1024 * 1024;
const MAX_ASSISTANT_TEXT_CHARS = 4_000_000;
const MAX_TOOL_ARGUMENT_CHARS = 1_048_576;
const MAX_MODELS_JSON_BYTES = 1_048_576;
const MAX_CHUNK_CONTENT_CHARS = 256_000;
const OLLAMA_CLOUD_TAGS_URL = "https://ollama.com/api/tags";
/** Flagship Ollama cloud models only — latest per family, no retired/smaller siblings. */
const OLLAMA_TOP_TIER_CLOUD_MODELS: ReadonlySet<string> = new Set([
  "glm-5.2",
  "kimi-k3",
  "deepseek-v4-pro",
  "minimax-m3",
  "qwen3.5:397b",
  "mistral-large-3:675b",
  "nemotron-3-ultra",
  "gpt-oss:120b",
  "gemma4:31b",
]);
const ModelsListSchema = Type.Object(
  {
    data: Type.Union([Type.Array(Type.Unknown()), Type.Null()]),
  },
  { additionalProperties: true },
);
const JsonObjectSchema = Type.Record(Type.String(), Type.Unknown());
const ToolCallDeltaSchema = Type.Object(
  {
    index: Type.Integer({ minimum: 0, maximum: 100 }),
    id: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    type: Type.Optional(Type.Literal("function")),
    function: Type.Optional(
      Type.Object(
        {
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
          arguments: Type.Optional(
            Type.Union([
              Type.String({ maxLength: MAX_SSE_EVENT_CHARS }),
              JsonObjectSchema,
            ]),
          ),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);
const ChunkSchema = Type.Object(
  {
    choices: Type.Array(
      Type.Object(
        {
          delta: Type.Object(
            {
              content: Type.Optional(
                Type.Union([
                  Type.String({ maxLength: MAX_CHUNK_CONTENT_CHARS }),
                  Type.Null(),
                ]),
              ),
              tool_calls: Type.Optional(Type.Array(ToolCallDeltaSchema)),
            },
            { additionalProperties: true },
          ),
          finish_reason: Type.Optional(
            Type.Union([Type.String({ maxLength: 100 }), Type.Null()]),
          ),
        },
        { additionalProperties: true },
      ),
      { maxItems: 100 },
    ),
    usage: Type.Optional(
      Type.Object(
        {
          prompt_tokens: Type.Integer({ minimum: 0 }),
          completion_tokens: Type.Integer({ minimum: 0 }),
          total_tokens: Type.Integer({ minimum: 0 }),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

type StreamChunk = typeof ChunkSchema.static;
type ToolDelta = typeof ToolCallDeltaSchema.static;

interface PendingToolCall {
  id?: string;
  name?: string;
  argumentFragments: string[];
  objectArguments?: Readonly<Record<string, unknown>>;
}

interface StreamState {
  readonly tools: Map<number, PendingToolCall>;
  completed: boolean;
  totalBytes: number;
  assistantTextChars: number;
  toolArgumentChars: number;
}

export class FetchHttpTransport implements HttpTransport {
  public fetch(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, { ...init, redirect: "error" });
  }
}

export class OpenAiCompatibleProvider implements AiProvider {
  private readonly config: ProviderConfig;

  public constructor(
    config: ProviderConfig,
    private readonly transport: HttpTransport = new FetchHttpTransport(),
  ) {
    this.config = validateProviderConfig(config);
  }

  /**
   * Streams `/chat/completions` and normalizes provider-specific SSE chunks.
   *
   * @example provider.streamChat({ messages, tools }, abortController.signal)
   */
  public async *streamChat(
    request: StreamChatRequest,
    abortSignal: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    if (abortSignal.aborted) {
      throw new DomainError("ABORTED", "Provider run cancelled");
    }
    const timeout = createTimeoutSignal(abortSignal, this.config.timeoutMs);
    try {
      const response = await this.fetchCompletion(request, timeout.signal);
      yield* decodeProviderStream(response, timeout.signal);
    } catch (error: unknown) {
      throw normalizeProviderError(error, abortSignal, timeout.didTimeout());
    } finally {
      timeout.dispose();
    }
  }

  /**
   * Tests OpenAI-compatible `GET /models`, falling back to Ollama `GET /api/tags`.
   *
   * @example await provider.testConnection(new AbortController().signal)
   */
  public async testConnection(abortSignal: AbortSignal): Promise<void> {
    try {
      await this.fetchModelsBody(abortSignal);
    } catch (openAiError: unknown) {
      const tags = await this.fetchOllamaTags(abortSignal);
      if (tags !== null) return;
      throw openAiError;
    }
  }

  /**
   * Returns local model IDs, merging Ollama cloud catalog entries when the
   * configured host is loopback Ollama (so `:cloud` models stay selectable).
   *
   * @example await provider.listModels(new AbortController().signal)
   */
  public async listModels(abortSignal: AbortSignal): Promise<readonly string[]> {
    const local = await this.listLocalModelIds(abortSignal);
    const cloud = this.isLoopbackOllamaHost()
      ? await this.fetchOllamaCloudCatalog(abortSignal)
      : [];
    const merged = uniqueModelIds([...local, ...cloud]);
    if (merged.length) return merged.slice(0, 500);
    if (local.length === 0 && (await this.ollamaTagsReachable(abortSignal))) {
      return [];
    }
    throw new DomainError(
      "PROVIDER",
      `Provider at ${this.config.baseUrl} returned no models from /models or /api/tags`,
    );
  }

  /**
   * Returns whether a model is available via Ollama `/api/show`, or present in
   * the OpenAI-compatible models list when show is unavailable.
   *
   * @example await provider.modelAvailable('glm-5.2:cloud', signal)
   */
  public async modelAvailable(
    model: string,
    abortSignal: AbortSignal,
  ): Promise<boolean> {
    const trimmed = model.trim();
    if (!trimmed) return false;
    if (await this.ollamaShowSucceeds(trimmed, abortSignal)) return true;
    if (this.ollamaShowEndpoint()) return false;
    try {
      const models = await this.listLocalModelIds(abortSignal);
      return models.includes(trimmed);
    } catch {
      return false;
    }
  }

  /**
   * Resolves the context window for a model from Ollama `/api/show`, or null
   * when the endpoint does not expose it. OpenAI-compatible `/v1/models` does
   * not standardize a context length field, so we probe the Ollama-native
   * endpoint as a documented fallback and treat any failure as unknown.
   *
   * @example await provider.contextWindow('llama3', new AbortController().signal)
   */
  public async contextWindow(
    model: string,
    abortSignal: AbortSignal,
  ): Promise<number | null> {
    try {
      const body = await this.fetchOllamaShow(model, abortSignal);
      if (!body) return null;
      const ctx = findContextLength(body.model_info ?? {});
      return ctx ?? null;
    } catch {
      return null;
    }
  }

  private async listLocalModelIds(
    abortSignal: AbortSignal,
  ): Promise<readonly string[]> {
    try {
      const body = await this.fetchModelsBody(abortSignal);
      const entries = Array.isArray(body.data) ? body.data : [];
      const ids = entries
        .map(modelIdFromEntry)
        .filter((id): id is string => Boolean(id));
      if (ids.length) return ids;
    } catch {
      // Prefer Ollama-native tags when the OpenAI models route is missing.
    }
    const tags = await this.fetchOllamaTags(abortSignal);
    return tags ?? [];
  }

  private async ollamaShowSucceeds(
    model: string,
    abortSignal: AbortSignal,
  ): Promise<boolean> {
    return (await this.fetchOllamaShow(model, abortSignal)) !== null;
  }

  private async fetchOllamaShow(
    model: string,
    abortSignal: AbortSignal,
  ): Promise<{ model_info?: Record<string, unknown> } | null> {
    const showUrl = this.ollamaShowEndpoint();
    if (!showUrl) return null;
    try {
      const response = await this.transport.fetch(showUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model }),
        redirect: "error",
        signal: abortSignal,
      });
      await assertSuccessfulResponse(response, "application/json");
      const text = await readResponseText(response, MAX_MODELS_JSON_BYTES);
      return JSON.parse(text) as { model_info?: Record<string, unknown> };
    } catch {
      return null;
    }
  }

  /**
   * Builds the Ollama-native `/api/show` URL from the configured base origin.
   */
  private ollamaShowEndpoint(): string | null {
    return this.ollamaNativeEndpoint("/api/show");
  }

  private ollamaTagsEndpoint(): string | null {
    return this.ollamaNativeEndpoint("/api/tags");
  }

  private ollamaNativeEndpoint(pathname: string): string | null {
    let base: URL;
    try {
      base = new URL(this.config.baseUrl);
    } catch {
      return null;
    }
    return new URL(pathname, base).toString();
  }

  private isLoopbackOllamaHost(): boolean {
    try {
      const host = new URL(this.config.baseUrl).hostname;
      return host === "localhost" || host === "127.0.0.1" || host === "::1";
    } catch {
      return false;
    }
  }

  private async ollamaTagsReachable(abortSignal: AbortSignal): Promise<boolean> {
    return (await this.fetchOllamaTags(abortSignal)) !== null;
  }

  /**
   * Lists installed Ollama model names via `GET /api/tags`.
   * Returns `[]` when reachable but empty, `null` when unavailable.
   */
  private async fetchOllamaTags(
    abortSignal: AbortSignal,
  ): Promise<readonly string[] | null> {
    const tagsUrl = this.ollamaTagsEndpoint();
    if (!tagsUrl) return null;
    return this.readOllamaTagNames(tagsUrl, abortSignal, false);
  }

  /**
   * Loads the public Ollama cloud catalog, keeps flagship models only, and maps
   * names to local `:cloud` ids.
   */
  private async fetchOllamaCloudCatalog(
    abortSignal: AbortSignal,
  ): Promise<readonly string[]> {
    const names = await this.readOllamaTagNames(
      OLLAMA_CLOUD_TAGS_URL,
      abortSignal,
      false,
    );
    if (!names) return [];
    return names
      .filter((name) => OLLAMA_TOP_TIER_CLOUD_MODELS.has(name))
      .map(toLocalCloudModelId);
  }

  private async readOllamaTagNames(
    tagsUrl: string,
    abortSignal: AbortSignal,
    useApiKey: boolean,
  ): Promise<readonly string[] | null> {
    try {
      const response = await this.transport.fetch(tagsUrl, {
        method: "GET",
        headers: this.headers(false, useApiKey),
        redirect: "error",
        signal: abortSignal,
      });
      await assertSuccessfulResponse(response, "application/json");
      const text = await readResponseText(response, MAX_MODELS_JSON_BYTES);
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || !("models" in parsed)) {
        return null;
      }
      const models = parsed.models;
      if (!Array.isArray(models)) return null;
      return models
        .map(ollamaTagNameFromEntry)
        .filter((name): name is string => Boolean(name));
    } catch {
      return null;
    }
  }

  private async fetchModelsBody(
    abortSignal: AbortSignal,
  ): Promise<{ data: readonly unknown[] | null }> {
    const response = await this.transport.fetch(this.endpoint("models"), {
      method: "GET",
      headers: this.headers(false),
      redirect: "error",
      signal: abortSignal,
    });
    await assertSuccessfulResponse(response, "application/json");
    const bodyText = await readResponseText(response, MAX_MODELS_JSON_BYTES);
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw malformedResponse(bodyText.slice(0, 100), "valid models JSON");
    }
    if (!Value.Check(ModelsListSchema, body)) {
      throw malformedResponse(
        body,
        "a models object with a data array or null",
      );
    }
    const data = (body as { data: readonly unknown[] | null }).data;
    return { data };
  }

  private async fetchCompletion(
    request: StreamChatRequest,
    signal: AbortSignal,
  ): Promise<Response> {
    const response = await this.transport.fetch(
      this.endpoint("chat/completions"),
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify(serializeRequest(this.config, request)),
        redirect: "error",
        signal,
      },
    );
    await assertSuccessfulResponse(response, "text/event-stream");
    return response;
  }

  private endpoint(relativePath: string): string {
    return new URL(relativePath, this.config.baseUrl).toString();
  }

  private headers(
    jsonBody: boolean,
    includeApiKey = true,
  ): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (jsonBody) {
      headers.Accept = "text/event-stream";
      headers["Content-Type"] = "application/json";
    }
    if (includeApiKey && this.config.apiKey)
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    return headers;
  }
}

function toLocalCloudModelId(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  if (trimmed.endsWith(":cloud") || trimmed.endsWith("-cloud")) return trimmed;
  return trimmed.includes(":") ? `${trimmed}-cloud` : `${trimmed}:cloud`;
}

function modelIdFromEntry(entry: unknown): string | null {
  if (!entry || typeof entry !== "object" || !("id" in entry)) return null;
  const id = entry.id;
  return typeof id === "string" ? id.trim() : null;
}

function ollamaTagNameFromEntry(entry: unknown): string | null {
  if (!entry || typeof entry !== "object" || !("name" in entry)) return null;
  const name = entry.name;
  return typeof name === "string" ? name.trim() : null;
}

function uniqueModelIds(ids: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function serializeRequest(
  config: ProviderConfig,
  request: StreamChatRequest,
): object {
  return {
    model: config.model,
    stream: true,
    stream_options: { include_usage: true },
    temperature: config.temperature,
    max_tokens: config.maxOutputTokens,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
      ...(message.toolCalls
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            })),
          }
        : {}),
    })),
    tools: request.tools.map((tool) => ({
      type: "function",
      function: tool,
    })),
  };
}

async function* decodeProviderStream(
  response: Response,
  signal: AbortSignal,
): AsyncIterable<ProviderEvent> {
  if (!response.body)
    throw malformedResponse(null, "a streaming response body");
  const rawEvents: string[] = [];
  const parseErrors: ParseError[] = [];
  const parser = createParser({
    maxBufferSize: MAX_SSE_EVENT_CHARS,
    onEvent: (event): void => {
      rawEvents.push(event.data);
    },
    onError: (error): void => {
      parseErrors.push(error);
    },
  });
  const decoder = new TextDecoder();
  const state: StreamState = {
    tools: new Map(),
    completed: false,
    totalBytes: 0,
    assistantTextChars: 0,
    toolArgumentChars: 0,
  };
  const reader = response.body.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (signal.aborted) throw signal.reason;
      state.totalBytes += result.value.byteLength;
      assertStreamByteLimit(state.totalBytes);
      parser.feed(decoder.decode(result.value, { stream: true }));
      yield* drainParsedEvents(rawEvents, parseErrors, state);
    }
  } finally {
    reader.releaseLock();
  }
  parser.feed(decoder.decode());
  parser.reset({ consume: true });
  yield* drainParsedEvents(rawEvents, parseErrors, state);
  if (!state.completed) throw malformedResponse(null, "a completion marker");
}

function* drainParsedEvents(
  rawEvents: string[],
  parseErrors: ParseError[],
  state: StreamState,
): Iterable<ProviderEvent> {
  const parseError = parseErrors.shift();
  if (parseError) {
    throw new DomainError(
      "PROVIDER",
      `Invalid SSE event ${safeValue(parseError.line)}; expected an event under ${MAX_SSE_EVENT_CHARS} characters`,
      parseError,
    );
  }
  for (const rawEvent of rawEvents.splice(0)) {
    yield* processRawEvent(rawEvent, state);
  }
}

function* processRawEvent(
  rawEvent: string,
  state: StreamState,
): Iterable<ProviderEvent> {
  if (rawEvent === "[DONE]") {
    if (!state.completed) yield* finishStream(state, "stop");
    return;
  }
  const chunk = parseChunk(rawEvent);
  state.totalBytes += rawEvent.length;
  assertStreamByteLimit(state.totalBytes);
  for (const choice of chunk.choices) {
    if (choice.delta.content) {
      state.assistantTextChars += choice.delta.content.length;
      assertAssistantTextLimit(state.assistantTextChars);
      yield { type: "text-delta", delta: choice.delta.content };
    }
    for (const toolDelta of choice.delta.tool_calls ?? []) {
      accumulateToolDelta(state, toolDelta);
    }
    if (choice.finish_reason && !state.completed) {
      yield* finishStream(state, choice.finish_reason);
    }
  }
  if (chunk.usage) {
    yield {
      type: "usage",
      promptTokens: chunk.usage.prompt_tokens,
      outputTokens: chunk.usage.completion_tokens,
      totalTokens: chunk.usage.total_tokens,
    };
  }
}

function parseChunk(rawEvent: string): StreamChunk {
  if (rawEvent.length > MAX_SSE_EVENT_CHARS) {
    throw malformedResponse(rawEvent.slice(0, 100), "an SSE event under 1 MiB");
  }
  let input: unknown;
  try {
    input = JSON.parse(rawEvent);
  } catch (error: unknown) {
    throw new DomainError(
      "PROVIDER",
      `Invalid SSE JSON ${safeValue(rawEvent)}; expected an OpenAI chat chunk`,
      error,
    );
  }
  if (!Value.Check(ChunkSchema, input)) {
    throw malformedResponse(input, "an OpenAI chat completion chunk");
  }
  return input;
}

function accumulateToolDelta(state: StreamState, delta: ToolDelta): void {
  const tools = state.tools;
  const pending = tools.get(delta.index) ?? { argumentFragments: [] };
  if (delta.id) pending.id = delta.id;
  if (delta.function?.name) pending.name = delta.function.name;
  const args = delta.function?.arguments;
  if (typeof args === "string") {
    state.toolArgumentChars += args.length;
    assertToolArgumentLimit(state.toolArgumentChars);
    pending.argumentFragments.push(args);
  }
  if (typeof args === "object" && args !== null) {
    const encoded = JSON.stringify(args);
    state.toolArgumentChars += encoded.length;
    assertToolArgumentLimit(state.toolArgumentChars);
    pending.objectArguments = args;
  }
  tools.set(delta.index, pending);
}

function* finishStream(
  state: StreamState,
  finishReason: string,
): Iterable<ProviderEvent> {
  if (state.tools.size) {
    const calls = [...state.tools.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, pending]) => normalizeToolCall(pending));
    yield { type: "tool-calls", calls };
  }
  state.completed = true;
  yield { type: "completed", finishReason };
}

function normalizeToolCall(pending: PendingToolCall): NormalizedToolCall {
  if (!pending.id || !pending.name) {
    throw malformedResponse(pending, "a tool call with id and function name");
  }
  return {
    id: pending.id,
    name: pending.name,
    arguments:
      pending.objectArguments ?? parseToolArguments(pending.argumentFragments),
  };
}

function parseToolArguments(
  fragments: readonly string[],
): Readonly<Record<string, unknown>> {
  const encoded = fragments.join("") || "{}";
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch (error: unknown) {
    throw new DomainError(
      "PROVIDER",
      `Invalid tool arguments ${safeValue(encoded)}; expected a JSON object`,
      error,
    );
  }
  if (!Value.Check(JsonObjectSchema, parsed)) {
    throw malformedResponse(parsed, "tool arguments encoded as a JSON object");
  }
  return parsed;
}

async function assertSuccessfulResponse(
  response: Response,
  expectedType: string,
): Promise<void> {
  if (response.redirected) {
    throw new DomainError(
      "SECURITY",
      "Provider redirected the request; expected no redirects",
    );
  }
  if (!response.ok) {
    throw new DomainError(
      "PROVIDER",
      await providerHttpErrorMessage(response),
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes(expectedType)) {
    throw new DomainError(
      "PROVIDER",
      `Provider returned content type ${safeValue(contentType)}; expected ${expectedType}`,
    );
  }
}

async function providerHttpErrorMessage(response: Response): Promise<string> {
  const detail = await readProviderErrorDetail(response);
  if (response.status === 402) {
    return detail
      ? `Provider returned HTTP 402 (payment/usage required): ${detail}`
      : "Provider returned HTTP 402 (payment/usage required); add Ollama cloud credits or enable auto-reload at https://ollama.com/settings";
  }
  return detail
    ? `Provider returned HTTP ${response.status}: ${detail}`
    : `Provider returned HTTP ${response.status}; expected 2xx`;
}

async function readProviderErrorDetail(
  response: Response,
): Promise<string | null> {
  try {
    const text = (await response.clone().text()).trim();
    if (!text) return null;
    try {
      const body = JSON.parse(text) as { error?: unknown; message?: unknown };
      const error =
        typeof body.error === "string"
          ? body.error
          : typeof body.message === "string"
            ? body.message
            : null;
      if (error?.trim()) return truncateErrorDetail(error.trim());
    } catch {
      // Fall through to raw text.
    }
    return truncateErrorDetail(text);
  } catch {
    return null;
  }
}

function truncateErrorDetail(detail: string): string {
  return detail.length > 300 ? `${detail.slice(0, 297)}...` : detail;
}

function createTimeoutSignal(
  parent: AbortSignal,
  timeoutMs: number,
): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const abort = (): void => controller.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });
  const timer = setTimeout((): void => {
    timedOut = true;
    controller.abort(new Error("provider timeout"));
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: (): boolean => timedOut,
    dispose: (): void => {
      clearTimeout(timer);
      parent.removeEventListener("abort", abort);
    },
  };
}

function normalizeProviderError(
  error: unknown,
  parentSignal: AbortSignal,
  timedOut: boolean,
): DomainError {
  if (error instanceof DomainError) return error;
  if (parentSignal.aborted)
    return new DomainError("ABORTED", "Provider run cancelled", error);
  if (timedOut)
    return new DomainError("NETWORK", "Provider request timed out", error);
  const message = error instanceof Error ? error.message : String(error);
  return new DomainError(
    "NETWORK",
    `Provider request failed with ${safeValue(message)}; expected a reachable endpoint`,
    error,
  );
}

function malformedResponse(input: unknown, expected: string): DomainError {
  return new DomainError(
    "PROVIDER",
    `Malformed provider response ${safeValue(input)}; expected ${expected}`,
  );
}

async function readResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) {
    throw malformedResponse(null, "a response body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        throw new DomainError(
          "LIMIT_EXCEEDED",
          `Provider response exceeded ${maxBytes} bytes; expected a bounded body`,
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function assertStreamByteLimit(totalBytes: number): void {
  if (totalBytes <= MAX_TOTAL_SSE_BYTES) return;
  throw new DomainError(
    "LIMIT_EXCEEDED",
    `Provider stream exceeded ${MAX_TOTAL_SSE_BYTES} bytes; expected a bounded response`,
  );
}

function assertAssistantTextLimit(totalChars: number): void {
  if (totalChars <= MAX_ASSISTANT_TEXT_CHARS) return;
  throw new DomainError(
    "LIMIT_EXCEEDED",
    `Provider assistant text exceeded ${MAX_ASSISTANT_TEXT_CHARS} characters; expected a bounded response`,
  );
}

function assertToolArgumentLimit(totalChars: number): void {
  if (totalChars <= MAX_TOOL_ARGUMENT_CHARS) return;
  throw new DomainError(
    "LIMIT_EXCEEDED",
    `Provider tool arguments exceeded ${MAX_TOOL_ARGUMENT_CHARS} characters; expected a bounded response`,
  );
}

function findContextLength(
  modelInfo: Record<string, unknown>,
): number | null {
  const keys = [
    "llama.context_length",
    "general.context_length",
    "context_length",
    "max_context_length",
  ];
  for (const key of keys) {
    const value = modelInfo[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  return null;
}
