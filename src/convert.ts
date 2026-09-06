import * as vscode from "vscode";
import { formatErrorValue } from "./client";
import { estimateTextTokens } from "./contextBudget";
import type { ChatContentPart, ChatMessage, ChatTool } from "./types";

/**
 * Convert VS Code chat request messages to OpenAI Chat Completions messages.
 *
 * VS Code sends the FULL conversation history on every request. One VS Code
 * message can expand into several OpenAI messages (each tool result becomes
 * its own `role: "tool"` message).
 */
export function toOpenAiMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[]
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const msg of messages) {
    appendMessage(out, msg);
  }
  return reorderSystemMessages(out);
}

/** Consecutive identical tool calls tolerated before the request is refused.
 * Agent loops ("Ran Initial Instructions" ×20) re-bill the full history on
 * every iteration, so stopping early with a clear message saves real tokens.
 * Five is generous: legitimate flows rarely repeat the exact same call
 * (same name + same args) even twice in a row. */
export const MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS = 5;

export interface IdenticalToolCallRun {
  name: string;
  count: number;
}

function canonicalizeArgs(input: unknown): string {
  if (typeof input === "string") return input;
  if (input === null || input === undefined) return "{}";
  if (typeof input !== "object") return String(input);
  try {
    return JSON.stringify(sortKeys(input));
  } catch {
    return JSON.stringify(input);
  }
}

function sortKeys(val: unknown): unknown {
  if (Array.isArray(val)) return val.map(sortKeys);
  if (val && typeof val === "object") {
    const entries = Object.entries(val as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortKeys(v)]);
    return Object.fromEntries(entries);
  }
  return val;
}

/** Trailing run of identical (name + args) tool calls in VS Code history.
 * Returns the run length so the provider can refuse an obvious model loop
 * instead of paying for one more identical iteration.
 *
 * Trailing means active at the tail of the conversation. An intervening user
 * prompt (not a tool result) or an assistant text response resets the run,
 * so rephrasing, retrying, or sending a new message is never blocked by a past loop. */
export function trailingIdenticalToolCalls(
  messages: readonly vscode.LanguageModelChatRequestMessage[]
): IdenticalToolCallRun | undefined {
  if (!messages.length) return undefined;

  let targetKey: string | undefined;
  let targetName: string | undefined;
  let count = 0;

  const reversedMessages = [...messages].reverse();
  for (const msg of reversedMessages) {
    const parts = Array.isArray(msg.content) ? msg.content : [];
    const hasToolResult = parts.some((p) => p instanceof vscode.LanguageModelToolResultPart);
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];
    let hasAssistantText = false;

    for (const part of parts) {
      if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(part);
      } else if (
        part instanceof vscode.LanguageModelTextPart &&
        part.value.trim().length > 0 &&
        msg.role === vscode.LanguageModelChatMessageRole.Assistant
      ) {
        hasAssistantText = true;
      }
    }

    if (targetKey === undefined) {
      // If conversation ends with a user prompt (not tool results),
      // the user has intervened. There are no trailing tool calls.
      if (!hasToolResult && msg.role !== vscode.LanguageModelChatMessageRole.Assistant) {
        return undefined;
      }

      // If conversation ends with an assistant text response and no tool calls,
      // the model already answered. No trailing tool calls.
      if (toolCalls.length === 0 && hasAssistantText) {
        return undefined;
      }

      // If this message has tool calls, inspect newest to oldest.
      if (toolCalls.length > 0) {
        const reversedCalls = [...toolCalls].reverse();
        for (const tc of reversedCalls) {
          const args = canonicalizeArgs(tc.input);
          const key = `${tc.name}\n${args}`;
          if (targetKey === undefined) {
            targetKey = key;
            targetName = tc.name;
            count = 1;
          } else if (key === targetKey) {
            count++;
          } else {
            return { name: targetName ?? "", count };
          }
        }
        continue;
      }

      // If it's a tool result message, continue backwards to find the assistant tool call.
      if (hasToolResult) {
        continue;
      }

      continue;
    }

    // Target key is set. Check if run is broken:
    // 1. User prompt (not a tool result) breaks the run:
    if (!hasToolResult && msg.role !== vscode.LanguageModelChatMessageRole.Assistant) {
      break;
    }

    // 2. Assistant text answer (no tool calls) breaks the run:
    if (toolCalls.length === 0 && hasAssistantText) {
      break;
    }

    // 3. Inspect tool calls in this message (newest to oldest):
    if (toolCalls.length > 0) {
      let runBroken = false;
      const reversedCalls = [...toolCalls].reverse();
      for (const tc of reversedCalls) {
        const args = canonicalizeArgs(tc.input);
        const key = `${tc.name}\n${args}`;
        if (key === targetKey) {
          count++;
        } else {
          runBroken = true;
          break;
        }
      }
      if (runBroken) {
        break;
      }
    }
  }

  if (targetKey === undefined || count === 0) return undefined;
  return { name: targetName ?? "", count };
}

type ChatRequestParts = vscode.LanguageModelChatRequestMessage["content"];

/** Convert one VS Code request message into its OpenAI messages. */
function appendMessage(
  out: ChatMessage[],
  msg: vscode.LanguageModelChatRequestMessage
): void {
  const parts = Array.isArray(msg.content) ? msg.content : [];
  const { toolResults, toolCalls } = splitToolParts(parts);

  if (toolResults.length > 0) {
    appendToolResults(out, parts, toolResults);
    return;
  }

  if (msg.role === vscode.LanguageModelChatMessageRole.Assistant && toolCalls.length > 0) {
    out.push(buildAssistantMessage(parts, toolCalls));
    return;
  }

  const content = toContent(msg.content);
  if (!isEmptyContent(content)) {
    out.push({ role: mapRole(msg.role), content });
  }
}

/** Split message parts into tool result parts vs. tool call parts. */
function splitToolParts(parts: ChatRequestParts): {
  toolResults: vscode.LanguageModelToolResultPart[];
  toolCalls: vscode.LanguageModelToolCallPart[];
} {
  const toolResults: vscode.LanguageModelToolResultPart[] = [];
  const toolCalls: vscode.LanguageModelToolCallPart[] = [];
  for (const p of parts) {
    if (p instanceof vscode.LanguageModelToolResultPart) {
      toolResults.push(p);
    } else if (p instanceof vscode.LanguageModelToolCallPart) {
      toolCalls.push(p);
    }
  }
  return { toolResults, toolCalls };
}

/** One OpenAI `tool` message per result, plus a `user` message for the rest. */
function appendToolResults(
  out: ChatMessage[],
  parts: ChatRequestParts,
  toolResults: vscode.LanguageModelToolResultPart[]
): void {
  for (const result of toolResults) {
    out.push({
      role: "tool",
      content: extractToolResultText(result.content),
      tool_call_id: result.callId,
    });
  }
  const rest = toContent(parts);
  if (!isEmptyContent(rest)) out.push({ role: "user", content: rest });
}

/** Assistant message carrying tool calls, as OpenAI expects. */
function buildAssistantMessage(
  parts: ChatRequestParts,
  toolCalls: vscode.LanguageModelToolCallPart[]
): ChatMessage {
  const text = parts
    .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
    .map((p) => p.value)
    .join("");
  return {
    role: "assistant",
    // Preserve model-authored visible text beside tool calls.
    // Whitespace alone is not meaningful content.
    content: text.trim().length > 0 ? text : null,
    tool_calls: toolCalls.map((tc) => ({
      id: tc.callId,
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input ?? {}),
      },
    })),
  };
}

/**
 * Some VS Code request histories place system instructions after the
 * conversation. Some upstream adapters also require one leading system
 * message, not several system entries interleaved with tool messages.
 */
function reorderSystemMessages(out: ChatMessage[]): ChatMessage[] {
  const system = out.filter((message) => message.role === "system");
  if (system.length === 0) return out;
  return [mergeSystemMessages(system), ...out.filter((message) => message.role !== "system")];
}

function mergeSystemMessages(system: ChatMessage[]): ChatMessage {
  const systemText: string[] = [];
  const systemParts: ChatContentPart[] = [];
  for (const message of system) {
    if (typeof message.content === "string") {
      systemText.push(message.content);
    } else if (Array.isArray(message.content)) {
      systemParts.push(...message.content);
    }
  }
  if (systemParts.length === 0) {
    return {
      role: "system",
      content: systemText.join("\n\n"),
    };
  }
  if (systemText.length > 0) {
    systemParts.unshift({ type: "text", text: systemText.join("\n\n") });
  }
  return {
    role: "system",
    content: systemParts,
  };
}

function mapRole(role: vscode.LanguageModelChatMessageRole): "system" | "user" | "assistant" {
  if (role === vscode.LanguageModelChatMessageRole.Assistant) return "assistant";
  // System is not in the stable VS Code enum, but some editor versions send
  // it at runtime as numeric 3 or the literal string "system".
  if ((role as unknown) === 3 || String(role).toLowerCase() === "system") return "system";
  return "user";
}

/** Text + images → string (single text) or OpenAI content-part array. */
function toContent(content: unknown): string | ChatContentPart[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: ChatContentPart[] = [];
  for (const part of content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      parts.push({ type: "text", text: part.value });
    } else if (
      part instanceof vscode.LanguageModelDataPart &&
      typeof part.mimeType === "string" &&
      part.mimeType.startsWith("image/")
    ) {
      const base64 = Buffer.from(part.data).toString("base64");
      parts.push({ type: "image_url", image_url: { url: `data:${part.mimeType};base64,${base64}` } });
    }
  }

  // Plain string is the most compatible shape when there is no image.
  if (parts.length === 1 && parts[0].type === "text") return parts[0].text;
  return parts;
}

export function isEmptyContent(content: string | ChatContentPart[] | null): boolean {
  if (content === null || content === undefined) return true;
  if (typeof content === "string") return content.trim().length === 0;
  if (content.length === 0) return true;
  return content.every((p) => p.type === "text" && p.text.trim().length === 0);
}

/** Max chars forwarded per tool result. Copilot resends full history every
 * turn, so an unbounded tool output (file read, search) would be rebilled on
 * every subsequent request. Truncation keeps one bad tool from blowing the
 * context budget for the whole session. ~12K chars ≈ 3K tokens. */
export const MAX_TOOL_RESULT_CHARS = 12_000;

function truncateToolText(text: string): string {
  return smartTruncate(text, MAX_TOOL_RESULT_CHARS);
}

/** Truncates long text keeping head + tail instead of only the head: tool
 * outputs (terminal logs, search results) usually carry the cause at the
 * start and the outcome at the end, so middle-out truncation preserves both
 * for the same token budget. */
export function smartTruncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.ceil(maxChars * (2 / 3));
  const tailChars = maxChars - headChars;
  const dropped = text.length - maxChars;
  return (
    text.slice(0, headChars) +
    `\n…[truncated ${dropped} middle chars to save context]…\n` +
    text.slice(text.length - tailChars)
  );
}

export function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return truncateToolText(content);
  if (Array.isArray(content)) {
    const joined = content
      .map((c) => {
        if (c instanceof vscode.LanguageModelTextPart) return c.value;
        if (c && typeof c === "object" && "value" in c) {
          const val = (c as Record<string, unknown>).value;
          // Objects must not fall through to String() (that would render the
          // useless "[object Object]"); keep null/undefined as an empty string.
          return val === undefined || val === null ? "" : formatErrorValue(val);
        }
        return typeof c === "string" ? c : JSON.stringify(c);
      })
      .join("");
    return truncateToolText(joined);
  }
  return content === undefined || content === null ? "" : truncateToolText(String(content));
}

export function toOpenAiTools(
  tools: readonly vscode.LanguageModelChatTool[] | undefined
): ChatTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    },
  }));
}

/** Token estimate shared with the context budget (chars/4 with non-ASCII
 * weighting). Must stay fast: VS Code calls it a lot. */
export function estimateTokens(text: string | vscode.LanguageModelChatRequestMessage): number {
  if (typeof text === "string") return estimateTextTokens(text);

  const parts = Array.isArray(text.content) ? text.content : [];
  let tokens = 0;
  for (const part of parts) {
    if (part instanceof vscode.LanguageModelTextPart) {
      tokens += estimateTextTokens(part.value);
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      tokens += estimateTextTokens(part.name + JSON.stringify(part.input ?? {}));
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      tokens += estimateTextTokens(extractToolResultText(part.content));
    } else if (part instanceof vscode.LanguageModelDataPart) {
      tokens += 4000; // flat estimate per image/binary attachment
    }
  }
  return tokens;
}
