/**
 * Wire-contract fixtures for OmniRoute v3.8.50.
 *
 * Every literal here was derived from the audited v3.8.50 source
 * (branch `v3.8.50`, commit 74389b89a), not invented. If OmniCopilot's
 * parsers drift from these shapes, these fixtures are the reference to
 * reconcile against; if OmniRoute changes its contract, update them here
 * with a source citation.
 */

/** GET /v1/search — src/app/api/v1/search/route.ts (GET handler). */
export const SEARCH_PROVIDERS_RESPONSE = {
  object: "list",
  data: [
    {
      id: "duckduckgo-free",
      object: "search_provider",
      created: 1756100000,
      name: "DuckDuckGo (Free)",
      search_types: ["web"],
    },
    {
      id: "brave-search",
      object: "search_provider",
      created: 1756100000,
      name: "Brave Search",
      search_types: ["web", "news"],
    },
  ],
} as const;

/** GET /v1/models?prefix=alias — one chat row and one specialty row,
 * per src/app/api/v1/models/catalog.ts syncedFields builder (:1163-1239). */
export const MODELS_RESPONSE = {
  object: "list",
  data: [
    {
      id: "openai/gpt-4o",
      object: "model",
      created: 1756100000,
      owned_by: "openai",
      permission: [],
      root: "gpt-4o",
      parent: null,
      context_length: 128000,
      max_output_tokens: 16384,
      capabilities: { tool_calling: true, vision: true, reasoning: false },
    },
    {
      id: "anthropic/claude-sonnet-4-5",
      object: "model",
      created: 1756100000,
      owned_by: "anthropic",
      permission: [],
      root: "claude-sonnet-4-5",
      parent: null,
      type: undefined,
      supported_endpoints: ["chat"],
      context_length: 200000,
      max_output_tokens: 64000,
      capabilities: { tool_calling: true, reasoning: true, thinking: true },
    },
    {
      // Specialty registry rows must never reach the Copilot Chat picker.
      id: "jina/jina-reranker-v3",
      object: "model",
      created: 1756100000,
      owned_by: "jina",
      permission: [],
      root: "jina-reranker-v3",
      parent: null,
      type: "rerank",
      supported_endpoints: ["/rerank"],
    },
  ],
} as const;

/**
 * Chat Completions keep-alive frame — earlyStreamKeepalive.ts
 * OPENAI_KEEPALIVE_FRAME (empty delta chunk). Must NOT reset the client's
 * idle watchdog (provider.ts processChoice ignores empty deltas).
 */
export const CHAT_KEEPALIVE_FRAME =
  'data: {"id":"chatcmpl-keepalive","object":"chat.completion.chunk","created":0,"model":"keepalive","choices":[{"index":0,"delta":{},"finish_reason":null}]}';

/** Responses API heartbeat — sseHeartbeat.ts OPENAI_RESPONSES shape. */
export const RESPONSES_HEARTBEAT_FRAME = 'data: {"type":"response.in_progress"}';

/** Anthropic Messages ping frame — earlyStreamKeepalive.ts ANTHROPIC_PING_FRAME. */
export const MESSAGES_PING_FRAME = 'event: ping\ndata: {"type":"ping"}';

/** Terminal markers per protocol — stream.ts shouldEmitDoneTerminator():
 * only Chat Completions clients receive `data: [DONE]`; Responses ends on
 * `response.completed`; Messages on `message_stop`. */
export const TERMINAL_MARKERS = {
  chatCompletions: "data: [DONE]",
  responses: 'data: {"type":"response.completed"}',
  messages: 'data: {"type":"message_stop"}',
} as const;

/** Error envelope — open-sse/utils/error.ts buildErrorBody() +
 * open-sse/config/errorConfig.ts status→type/code map. */
export function errorBody(status: number, message: string): string {
  return JSON.stringify({ error: { message, status } });
}

/** Unknown model rejection — src/sse/handlers/chatHelpers.ts:255-260:
 * HTTP 400, type model_not_found. Definitive for the candidate; the
 * provider must fail over instead of retrying or killing the chain. */
export const MODEL_NOT_FOUND_400 = {
  status: 400,
  body: JSON.stringify({
    error: {
      message: "Model 'openai/gpt-9' could not be resolved to a known provider.",
      type: "invalid_request_error",
      code: "model_not_found",
    },
  }),
} as const;
