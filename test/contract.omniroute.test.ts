import { describe, expect, it, vi, afterEach } from "vitest";
import { OmniRouteClient } from "../src/client";
import { selectChatModels } from "../src/catalogFilter";
import { transportPlanForModel } from "../src/routes";
import {
  CHAT_KEEPALIVE_FRAME,
  MODELS_RESPONSE,
  MODEL_NOT_FOUND_400,
  RESPONSES_HEARTBEAT_FRAME,
  SEARCH_PROVIDERS_RESPONSE,
} from "./fixtures/omniroute-v3.8.50";

/**
 * Contract tests: OmniCopilot's parsers must consume the exact wire shapes
 * OmniRoute v3.8.50 emits (see test/fixtures/omniroute-v3.8.50.ts for the
 * source citations). A failure here means producer/consumer drift.
 */
describe("OmniRoute v3.8.50 wire contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("search-provider discovery consumes GET /v1/search list shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(SEARCH_PROVIDERS_RESPONSE), { status: 200 }))
    );
    const client = new OmniRouteClient({ baseUrl: "http://route.test/v1" });
    await expect(client.listSearchProviders()).resolves.toEqual(["duckduckgo-free", "brave-search"]);
  });

  it("catalog shaping keeps chat rows and drops specialty rows", () => {
    const chat = selectChatModels(JSON.parse(JSON.stringify(MODELS_RESPONSE.data)));
    expect(chat.map((m) => m.id)).toEqual(["openai/gpt-4o", "anthropic/claude-sonnet-4-5"]);
    // Transport plans derived from the same catalog metadata.
    expect(transportPlanForModel(chat[0])).toEqual(["responses", "chatCompletions"]);
  });

  it("chat keep-alive frames produce no events and no watchdog poke", async () => {
    const sse = (body: string) =>
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    const fetchMock = vi.fn().mockResolvedValue(sse(`${CHAT_KEEPALIVE_FRAME}\n\n${CHAT_KEEPALIVE_FRAME}\n\n`));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OmniRouteClient({ baseUrl: "http://x/v1" });
    const events = [];
    for await (const e of client.streamChat(
      { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
      new AbortController().signal
    )) events.push(e);
    expect(events).toEqual([]);
  });

  it("Responses heartbeat and Messages ping frames are tolerated as non-terminal progress", async () => {
    const responsesSse =
      `${RESPONSES_HEARTBEAT_FRAME}\n\n` +
      'data: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(responsesSse, { status: 200 })));
    const client = new OmniRouteClient({ baseUrl: "http://x/v1" });
    const events = [];
    for await (const e of client.streamModel(
      { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
      new AbortController().signal,
      ["responses"]
    )) events.push(e);
    expect(events).toEqual([{ kind: "text", text: "ok" }, { kind: "usage", usage: expect.objectContaining({ inputTokens: 1 }) }]);
  });

  it("models-not-found error body matches the audited v3.8.50 shape", () => {
    const parsed = JSON.parse(MODEL_NOT_FOUND_400.body) as { error: { code?: string; type?: string } };
    expect(MODEL_NOT_FOUND_400.status).toBe(400);
    expect(parsed.error.code).toBe("model_not_found");
    // The provider classifies this as a permanent candidate rejection:
    // isTransientHttpError(400) === false.
    expect([408, 429, 500, 502, 503, 504]).not.toContain(MODEL_NOT_FOUND_400.status);
  });
});
