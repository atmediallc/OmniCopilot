import * as vscode from "vscode";
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
    const parts = Array.isArray(msg.content) ? msg.content : [];

    const toolResults: vscode.LanguageModelToolResultPart[] = [];
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];

    for (const p of parts) {
      if (p instanceof vscode.LanguageModelToolResultPart) {
        toolResults.push(p);
      } else if (p instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(p);
      }
    }

    if (toolResults.length > 0) {
      for (const result of toolResults) {
        out.push({
          role: "tool",
          content: extractToolResultText(result.content),
          tool_call_id: result.callId,
        });
      }
      const rest = toContent(parts);
      if (!isEmptyContent(rest)) out.push({ role: "user", content: rest });
      continue;
    }

    if (msg.role === vscode.LanguageModelChatMessageRole.Assistant && toolCalls.length > 0) {
      const text = parts
        .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
        .map((p) => p.value)
        .join("");
      out.push({
        role: "assistant",
        // OpenAI expects null content when tool_calls are present and no text
        content: text || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.callId,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input ?? {}),
          },
        })),
      });
      continue;
    }

    const content = toContent(msg.content);
    if (!isEmptyContent(content)) {
      out.push({ role: mapRole(msg.role), content });
    }
  }

  return out;
}

function mapRole(role: vscode.LanguageModelChatMessageRole): "system" | "user" | "assistant" {
  if (role === vscode.LanguageModelChatMessageRole.Assistant) return "assistant";
  // Role 3 (System) is still proposed API — not in the stable enum, but the
  // editor may send it; map it defensively instead of downgrading to user.
  if ((role as number) === 3) return "system";
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

export function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (c instanceof vscode.LanguageModelTextPart) return c.value;
        if (c && typeof c === "object" && "value" in c) return String((c as { value: unknown }).value);
        return typeof c === "string" ? c : JSON.stringify(c);
      })
      .join("");
  }
  return content === undefined || content === null ? "" : String(content);
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

/** Cheap token estimate (chars/4) — the heuristic used by the official
 * sample and the Hugging Face provider. Must stay fast: VS Code calls it a lot. */
export function estimateTokens(text: string | vscode.LanguageModelChatRequestMessage): number {
  if (typeof text === "string") return Math.ceil(text.length / 4);

  const parts = Array.isArray(text.content) ? text.content : [];
  let chars = 0;
  for (const part of parts) {
    if (part instanceof vscode.LanguageModelTextPart) {
      chars += part.value.length;
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      chars += part.name.length + JSON.stringify(part.input ?? {}).length;
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      chars += extractToolResultText(part.content).length;
    } else if (part instanceof vscode.LanguageModelDataPart) {
      chars += 4000 * 4; // flat estimate per image/binary attachment
    }
  }
  return Math.ceil(chars / 4);
}
