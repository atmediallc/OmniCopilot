/** Shapes exchanged with the OmniRoute OpenAI-compatible API. */

/** One entry of GET /v1/models. OmniRoute enriches the OpenAI shape with
 * capabilities and context metadata; every extra field is optional so the
 * extension also works against vanilla OpenAI-compatible servers. */
export interface OmniRouteModel {
  id: string;
  object?: string;
  owned_by?: string;
  display_name?: string;
  type?: string;
  supported_endpoints?: string[];
  parent?: string;
  context_length?: number;
  max_completion_tokens?: number;
  capabilities?: {
    tool_calling?: boolean;
    vision?: boolean;
    reasoning?: boolean;
    attachment?: boolean;
    structured_output?: boolean;
    thinking?: boolean;
    [key: string]: unknown;
  };
}

export interface ModelsResponse {
  object: string;
  data: OmniRouteModel[];
}

/** One configured server entry (URLs live in config; the API key in secrets). */
export interface RouteConfig {
  id: string;
  name: string;
  baseUrl: string;
}

/** OpenAI Chat Completions request/stream shapes (subset we use). */

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: true;
  tools?: ChatTool[];
  tool_choice?: "auto" | "required";
  temperature?: number;
  max_tokens?: number;
}

/** Incremental tool-call fragment inside a stream delta. */
export interface StreamToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface StreamDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: StreamToolCallDelta[];
}

export interface StreamChunk {
  choices?: Array<{
    delta?: StreamDelta;
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
}

/** Normalized streaming events yielded by the client. */
export type StreamEvent =
  | { kind: "text"; text: string }
  | { kind: "toolCall"; id: string; name: string; args: string };
