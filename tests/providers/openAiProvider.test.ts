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
});
