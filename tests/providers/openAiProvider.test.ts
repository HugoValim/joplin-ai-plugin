import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OpenAiCompatibleProvider,
  type ProviderConfig,
  type HttpTransport,
  type ProviderEvent,
} from "../../src/providers/openAiProvider";

class FakeHttpTransport implements HttpTransport {
  public callCount = 0;
  public lastUrl = "";
  public lastInit: RequestInit | null = null;

  public constructor(private readonly response: Response) {}

  public async fetch(url: string, init: RequestInit): Promise<Response> {
    this.callCount += 1;
    this.lastUrl = url;
    this.lastInit = init;
    return Promise.resolve(this.response);
  }
}

function fragmentedResponse(content: string): Response {
  const bytes = new TextEncoder().encode(content);
  const splitPoints = [...new Set([7, 31, 89, 157, bytes.length])]
    .filter((point) => point > 0 && point <= bytes.length)
    .sort((left, right) => left - right);
  let start = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller): void {
      const end = splitPoints.shift();
      if (end === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(start, end));
      start = end;
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collectEvents(
  stream: AsyncIterable<ProviderEvent>,
): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const CONFIG: ProviderConfig = {
  baseUrl: "http://localhost:11434/v1",
  apiKey: "",
  model: "test-model",
  temperature: 0.2,
  maxOutputTokens: 500,
  timeoutMs: 5_000,
  allowInsecureRemote: false,
  allowedInsecureOrigin: "",
};

describe("OpenAiCompatibleProvider", () => {
  test("streams fragmented text and normalises parallel tool calls", async () => {
    const fixture = readFileSync(
      join(__dirname, "../fixtures/provider/parallel-tools.sse"),
      "utf8",
    );
    const provider = new OpenAiCompatibleProvider(
      CONFIG,
      new FakeHttpTransport(fragmentedResponse(fixture)),
    );

    const events = await collectEvents(
      provider.streamChat(
        {
          messages: [{ role: "user", content: "Read it" }],
          tools: [],
        },
        new AbortController().signal,
      ),
    );

    expect(events).toEqual([
      { type: "text-delta", delta: "Hel" },
      { type: "text-delta", delta: "lo" },
      { type: "usage", promptTokens: 10, outputTokens: 4, totalTokens: 14 },
      {
        type: "tool-calls",
        calls: [
          {
            id: "call-note",
            name: "read_note",
            arguments: { noteId: "n1" },
          },
          {
            id: "call-files",
            name: "list_text_files",
            arguments: { pattern: "**/*.md" },
          },
        ],
      },
      { type: "completed", finishReason: "tool_calls" },
    ]);
  });

  test("rejects malformed tool arguments", async () => {
    const sse =
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_note","arguments":"{"}}]}}]}',
        "",
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
        "",
      ].join("\n") + "\n";
    const provider = new OpenAiCompatibleProvider(
      CONFIG,
      new FakeHttpTransport(fragmentedResponse(sse)),
    );

    await expect(
      collectEvents(
        provider.streamChat(
          { messages: [{ role: "user", content: "Read" }], tools: [] },
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow("expected a JSON object");
  });

  test("rejects remote HTTP until explicitly confirmed", () => {
    expect(
      () =>
        new OpenAiCompatibleProvider(
          { ...CONFIG, baseUrl: "http://models.example.test/v1" },
          new FakeHttpTransport(fragmentedResponse("")),
        ),
    ).toThrow("requires explicit security confirmation");
  });

  test("redacts embedded endpoint credentials from validation errors", () => {
    let message = "";
    try {
      new OpenAiCompatibleProvider(
        {
          ...CONFIG,
          baseUrl: "https://alice:super-secret@example.test/v1",
        },
        new FakeHttpTransport(fragmentedResponse("")),
      );
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("without credentials");
    expect(message).not.toContain("super-secret");
  });

  test("does not contact transport when already cancelled", async () => {
    const transport = new FakeHttpTransport(fragmentedResponse(""));
    const provider = new OpenAiCompatibleProvider(CONFIG, transport);
    const controller = new AbortController();
    controller.abort();

    await expect(
      collectEvents(
        provider.streamChat(
          { messages: [{ role: "user", content: "Stop" }], tools: [] },
          controller.signal,
        ),
      ),
    ).rejects.toThrow("Provider run cancelled");
    expect(transport.callCount).toBe(0);
  });

  test("surfaces Ollama HTTP 402 payment/usage details from the provider body", async () => {
    const transport = new FakeHttpTransport(
      new Response(
        JSON.stringify({
          error:
            "this model uses extra usage only (not included plan usage) and your extra usage balance is empty, add extra usage or turn on auto reload at https://ollama.com/settings",
        }),
        {
          status: 402,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const provider = new OpenAiCompatibleProvider(CONFIG, transport);

    await expect(
      collectEvents(
        provider.streamChat(
          { messages: [{ role: "user", content: "hi" }], tools: [] },
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow(/HTTP 402 \(payment\/usage required\).*extra usage balance is empty/);
  });

  test("checks connectivity through GET models", async () => {
    const transport = new FakeHttpTransport(
      new Response(JSON.stringify({ data: [{ id: "test-model" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = new OpenAiCompatibleProvider(CONFIG, transport);

    await provider.testConnection(new AbortController().signal);

    expect(transport.lastUrl).toBe("http://localhost:11434/v1/models");
    expect(transport.lastInit?.method).toBe("GET");
    expect(transport.lastInit?.redirect).toBe("error");
  });

  test("lists models from Ollama /api/tags when /v1/models fails", async () => {
    class TagsFallbackTransport implements HttpTransport {
      public urls: string[] = [];

      public async fetch(url: string, _init: RequestInit): Promise<Response> {
        this.urls.push(url);
        if (url.endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({
              models: [
                { name: "glm-5.2:cloud" },
                { name: "kimi-k3:cloud" },
              ],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        return new Response("not found", { status: 404 });
      }
    }

    const transport = new TagsFallbackTransport();
    const provider = new OpenAiCompatibleProvider(CONFIG, transport);

    await expect(
      provider.listModels(new AbortController().signal),
    ).resolves.toEqual(["glm-5.2:cloud", "kimi-k3:cloud"]);
    expect(transport.urls[0]).toBe("http://localhost:11434/v1/models");
    expect(transport.urls).toContain("http://localhost:11434/api/tags");
    expect(transport.urls).toContain("https://ollama.com/api/tags");
  });

  test("treats null OpenAI models data as an empty online list", async () => {
    class NullDataTransport implements HttpTransport {
      public async fetch(url: string, _init: RequestInit): Promise<Response> {
        if (url.includes("/v1/models")) {
          return new Response(JSON.stringify({ object: "list", data: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url === "https://ollama.com/api/tags") {
          return new Response(
            JSON.stringify({
              models: [
                { name: "glm-5.2" },
                { name: "kimi-k3" },
                { name: "glm-5.1" },
                { name: "kimi-k2.5" },
                { name: "gpt-oss:20b" },
                { name: "deepseek-v4-flash" },
              ],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (url.endsWith("/api/tags")) {
          return new Response(JSON.stringify({ models: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }
    }

    const provider = new OpenAiCompatibleProvider(
      CONFIG,
      new NullDataTransport(),
    );
    await expect(
      provider.testConnection(new AbortController().signal),
    ).resolves.toBeUndefined();
    await expect(
      provider.listModels(new AbortController().signal),
    ).resolves.toEqual(["glm-5.2:cloud", "kimi-k3:cloud"]);
  });

  test("verifies a model through Ollama /api/show", async () => {
    class ShowTransport implements HttpTransport {
      public async fetch(url: string, init: RequestInit): Promise<Response> {
        if (url.endsWith("/api/show")) {
          const rawBody = init.body;
          const bodyText =
            typeof rawBody === "string"
              ? rawBody
              : rawBody instanceof Uint8Array
                ? new TextDecoder().decode(rawBody)
                : "";
          const body = JSON.parse(bodyText) as { name?: string };
          if (body.name === "glm-5.2:cloud") {
            return new Response(
              JSON.stringify({
                model_info: { "glm5.2.context_length": 1000 },
              }),
              {
                status: 200,
                headers: { "content-type": "application/json" },
              },
            );
          }
          return new Response("missing", { status: 404 });
        }
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }

    const provider = new OpenAiCompatibleProvider(CONFIG, new ShowTransport());
    await expect(
      provider.modelAvailable("glm-5.2:cloud", new AbortController().signal),
    ).resolves.toBe(true);
    await expect(
      provider.modelAvailable("missing:cloud", new AbortController().signal),
    ).resolves.toBe(false);
  });

  test("treats a successful Ollama /api/tags probe as online", async () => {
    class TagsOnlyTransport implements HttpTransport {
      public async fetch(url: string, _init: RequestInit): Promise<Response> {
        if (url.endsWith("/api/tags")) {
          return new Response(JSON.stringify({ models: [{ name: "glm-5.2:cloud" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }
    }

    const provider = new OpenAiCompatibleProvider(
      CONFIG,
      new TagsOnlyTransport(),
    );
    await expect(
      provider.testConnection(new AbortController().signal),
    ).resolves.toBeUndefined();
  });
});
