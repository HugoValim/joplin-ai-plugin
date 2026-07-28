export interface ProviderConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly allowInsecureRemote: boolean;
  readonly allowedInsecureOrigin: string;
}

export interface ProviderMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly NormalizedToolCall[];
}

export interface ProviderToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface StreamChatRequest {
  readonly messages: readonly ProviderMessage[];
  readonly tools: readonly ProviderToolDefinition[];
}

export interface NormalizedToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export type ProviderEvent =
  | { readonly type: "text-delta"; readonly delta: string }
  | {
      readonly type: "tool-calls";
      readonly calls: readonly NormalizedToolCall[];
    }
  | {
      readonly type: "usage";
      readonly promptTokens: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
    }
  | { readonly type: "completed"; readonly finishReason: string };

export interface AiProvider {
  /**
   * Streams one model step and yields normalized text, tool, usage, and completion events.
   *
   * @example provider.streamChat({ messages, tools }, abortController.signal)
   */
  streamChat(
    request: StreamChatRequest,
    abortSignal: AbortSignal,
  ): AsyncIterable<ProviderEvent>;

  /**
   * Checks endpoint reachability without exposing the configured credential.
   *
   * @example await provider.testConnection(new AbortController().signal)
   */
  testConnection(abortSignal: AbortSignal): Promise<void>;
}

export interface HttpTransport {
  /**
   * Sends a provider request through the environment's HTTP implementation.
   *
   * @example transport.fetch('https://example.test/models', { method: 'GET' })
   */
  fetch(url: string, init: RequestInit): Promise<Response>;
}
