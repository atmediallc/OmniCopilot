import { afterEach, describe, expect, it, vi } from "vitest";
import { OmniRouteClient } from "../src/client";
import type { StreamEvent } from "../src/types";

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(client: OmniRouteClient): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  const ctrl = new AbortController();
  for await (const e of client.streamChat(
    { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
    ctrl.signal
  )) {
    events.push(e);
  }
  return events;
}

describe("OmniRouteClient.streamChat", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("yields text deltas from SSE chunks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Hel"}}]}',
          'data: {"choices":[{"delta":{"content":"lo"}}]}',
          "data: [DONE]",
        ])
      )
    );
    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    expect(events).toEqual([
      { kind: "text", text: "Hel" },
      { kind: "text", text: "lo" },
    ]);
  });

  it("reassembles fragmented tool calls and flushes on finish_reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_","arguments":"{\\"pa"}}]}}]}',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"th\\":\\"a\\"}"}}]}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
          "data: [DONE]",
        ])
      )
    );
    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    expect(events).toEqual([
      { kind: "toolCall", id: "c1", name: "read_file", args: '{"path":"a"}' },
    ]);
  });

  it("flushes pending tool calls when the stream ends without finish_reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c9","function":{"name":"run","arguments":"{}"}}]}}]}',
        ])
      )
    );
    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    expect(events).toEqual([{ kind: "toolCall", id: "c9", name: "run", args: "{}" }]);
  });

  it("throws with the upstream error message on HTTP failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "no such model" } }), { status: 404 })
      )
    );
    await expect(collect(new OmniRouteClient({ baseUrl: "http://x/v1" }))).rejects.toThrow(
      /HTTP 404.*no such model/
    );
  });

  it("surfaces in-stream error payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(sseResponse(['data: {"error":{"message":"rate limited"}}']))
    );
    await expect(collect(new OmniRouteClient({ baseUrl: "http://x/v1" }))).rejects.toThrow(
      "rate limited"
    );
  });

  it("ignores malformed keep-alive lines", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        sseResponse([
          ": keep-alive",
          "data: not-json",
          'data: {"choices":[{"delta":{"content":"ok"}}]}',
          "data: [DONE]",
        ])
      )
    );
    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    expect(events).toEqual([{ kind: "text", text: "ok" }]);
  });

  it("sends Authorization only when an API key is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(["data: [DONE]"]));
    vi.stubGlobal("fetch", fetchMock);

    await collect(new OmniRouteClient({ baseUrl: "http://x/v1", apiKey: "sk-1" }));
    let headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-1");

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(sseResponse(["data: [DONE]"]));
    await collect(new OmniRouteClient({ baseUrl: "http://x/v1" }));
    headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("OmniRouteClient retry behavior", () => {
  afterEach(() => vi.unstubAllGlobals());

  const retry = { maxAttempts: 3, baseMs: 1, maxMs: 5 };

  it("retries transient 503 up to maxAttempts then throws upstream detail", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: "Chat admission capacity is temporarily unavailable. Retry shortly." },
        }),
        { status: 503 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      collect(new OmniRouteClient({ baseUrl: "http://x/v1", retry }))
    ).rejects.toThrow(/HTTP 503.*Chat admission capacity/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries 429 too", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(collect(new OmniRouteClient({ baseUrl: "http://x/v1", retry }))).rejects.toThrow(
      /HTTP 429/
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry permanent 4xx errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "no such model" } }), { status: 404 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(collect(new OmniRouteClient({ baseUrl: "http://x/v1", retry }))).rejects.toThrow(
      /HTTP 404.*no such model/
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recovers when a later attempt succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        sseResponse(['data: {"choices":[{"delta":{"content":"hi"}}]}', "data: [DONE]"])
      );
    vi.stubGlobal("fetch", fetchMock);

    const events = await collect(new OmniRouteClient({ baseUrl: "http://x/v1", retry }));
    expect(events).toEqual([{ kind: "text", text: "hi" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honors Retry-After over the backoff base", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 503, headers: { "retry-after": "0" } })
      )
      .mockResolvedValueOnce(sseResponse(["data: [DONE]"]));
    vi.stubGlobal("fetch", fetchMock);

    // A huge base delay proves Retry-After (0s here) is what makes this fast.
    const events = await collect(
      new OmniRouteClient({
        baseUrl: "http://x/v1",
        retry: { maxAttempts: 2, baseMs: 60_000, maxMs: 60_000 },
      })
    );
    expect(events).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops before the first request when already aborted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const ctrl = new AbortController();
    ctrl.abort();
    const client = new OmniRouteClient({ baseUrl: "http://x/v1", retry });
    await expect(
      (async () => {
        for await (const _event of client.streamChat(
          { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
          ctrl.signal
        )) {
          // no-op
        }
      })()
    ).rejects.toThrow(/aborted/i);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

describe("OmniRouteClient.listModels retry", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries transient 503 during model discovery", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "openai/gpt-4o" }] }), { status: 200 })
      );
    vi.stubGlobal("fetch", fetchMock);

    const models = await new OmniRouteClient({
      baseUrl: "http://x/v1",
      retry: { maxAttempts: 2, baseMs: 1 },
    }).listModels();
    expect(models).toEqual([{ id: "openai/gpt-4o" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
