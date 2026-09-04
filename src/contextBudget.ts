import type { ChatMessage, ChatTool } from "./types";

export type ContextMode = "manual" | "automatic";
export type ContextAutoPreset = "conservative" | "balanced" | "large" | "maximum";
export type ContextCapabilitySource = "catalog" | "fallback";

export interface ModelContextSettings {
  mode: ContextMode;
  maxContextTokens?: number;
  autoPreset?: ContextAutoPreset;
  revision?: number;
}

export interface ContextBudget {
  providerMaxContext: number;
  configuredMaxContext: number;
  effectiveMaxContext: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  availableInputTokens: number;
  providerLimitSource: ContextCapabilitySource;
  configuredLimitClamped: boolean;
  correctedMaxContextTokens?: number;
  outputLimitClamped: boolean;
  mode: ContextMode;
  autoPreset?: ContextAutoPreset;
}

export interface ContextAccounting {
  systemTokens: number;
  currentUserTokens: number;
  historyTokens: number;
  toolDefinitionTokens: number;
  attachmentTokens: number;
  totalInputTokens: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  totalContextTokens: number;
}

export type StoredModelContextSettings = Record<string, ModelContextSettings>;

export class ContextBudgetError extends Error {
  constructor(
    public readonly code:
      | "INVALID_CONTEXT_CONFIGURATION"
      | "PROTECTED_CONTEXT_OVERFLOW"
      | "UNKNOWN_CONTEXT_CAPABILITY",
    message: string
  ) {
    super(message);
    this.name = "ContextBudgetError";
  }
}

export const MODEL_CONTEXT_SETTINGS_KEY = "omnicopilot-dev.modelContextSettings.v1";
const MESSAGE_WIRE_OVERHEAD_TOKENS = 16;

export function modelContextSettingsKey(routeId: string, modelId: string): string {
  return JSON.stringify([routeId, modelId]);
}

function isTokenLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function normalizeProviderMaxContext(
  providerMaxContext: unknown,
  fallbackMaxContext: unknown
): { tokens: number; source: ContextCapabilitySource } {
  if (isTokenLimit(providerMaxContext)) return { tokens: providerMaxContext, source: "catalog" };
  if (isTokenLimit(fallbackMaxContext)) return { tokens: fallbackMaxContext, source: "fallback" };
  throw new ContextBudgetError("UNKNOWN_CONTEXT_CAPABILITY", "Model context capability is unavailable");
}

const AUTO_CONTEXT_LIMITS: Record<ContextAutoPreset, number> = {
  conservative: 16_000,
  balanced: 24_000,
  large: 64_000,
  maximum: Number.MAX_SAFE_INTEGER,
};

function normalizeSettings(settings: unknown): ModelContextSettings | undefined {
  if (!settings || typeof settings !== "object") return undefined;
  const raw = settings as Record<string, unknown>;
  if (raw.mode !== "manual" && raw.mode !== "automatic") return undefined;
  if (raw.maxContextTokens !== undefined && !isTokenLimit(raw.maxContextTokens)) return undefined;
  if (raw.revision !== undefined && (!Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0)) return undefined;
  const preset = raw.autoPreset;
  if (preset !== undefined && preset !== "conservative" && preset !== "balanced" && preset !== "large" && preset !== "maximum") {
    return undefined;
  }
  return {
    mode: raw.mode,
    ...(raw.maxContextTokens !== undefined ? { maxContextTokens: raw.maxContextTokens } : {}),
    ...(preset !== undefined ? { autoPreset: preset } : {}),
    ...(raw.revision !== undefined ? { revision: Number(raw.revision) } : {}),
  };
}

export function validateModelContextSettings(settings: unknown): ModelContextSettings {
  const normalized = normalizeSettings(settings);
  if (!normalized) {
    throw new ContextBudgetError("INVALID_CONTEXT_CONFIGURATION", "Invalid model context configuration");
  }
  return normalized;
}

export function readStoredContextSettings(value: unknown): StoredModelContextSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const valid: StoredModelContextSettings = {};
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    const settings = normalizeSettings(candidate);
    if (settings) valid[key] = settings;
  }
  return valid;
}

export function estimateContextInput(
  messages: readonly ChatMessage[],
  tools: readonly ChatTool[],
  budget: ContextBudget
): ContextAccounting {
  return account(messages, tools, budget);
}

export function resolveContextBudget(input: {
  providerMaxContext: unknown;
  fallbackMaxContext: unknown;
  settings?: unknown;
  requestedOutputTokens: unknown;
  safetyMarginTokens: unknown;
}): ContextBudget {
  const capability = normalizeProviderMaxContext(input.providerMaxContext, input.fallbackMaxContext);
  const settings = input.settings === undefined
    ? { mode: "manual" as const, maxContextTokens: capability.tokens }
    : validateModelContextSettings(input.settings);
  const requestedConfigured = settings.maxContextTokens ?? capability.tokens;
  const configuredLimitClamped = requestedConfigured > capability.tokens;
  const configuredMaxContext = Math.min(requestedConfigured, capability.tokens);
  const preset = settings.autoPreset ?? "balanced";
  const effectiveMaxContext = settings.mode === "automatic"
    ? Math.min(configuredMaxContext, AUTO_CONTEXT_LIMITS[preset])
    : configuredMaxContext;
  const safetyMarginTokens = Number.isSafeInteger(input.safetyMarginTokens) && Number(input.safetyMarginTokens) >= 0
    ? Number(input.safetyMarginTokens)
    : 0;
  const requestedOutputTokens = isTokenLimit(input.requestedOutputTokens) ? input.requestedOutputTokens : 1;
  const maxOutput = Math.max(0, effectiveMaxContext - safetyMarginTokens);
  const reservedOutputTokens = Math.min(requestedOutputTokens, maxOutput);
  return {
    providerMaxContext: capability.tokens,
    configuredMaxContext,
    effectiveMaxContext,
    reservedOutputTokens,
    safetyMarginTokens,
    availableInputTokens: effectiveMaxContext - reservedOutputTokens - safetyMarginTokens,
    providerLimitSource: capability.source,
    configuredLimitClamped,
    ...(configuredLimitClamped ? { correctedMaxContextTokens: configuredMaxContext } : {}),
    outputLimitClamped: reservedOutputTokens !== requestedOutputTokens,
    mode: settings.mode,
    ...(settings.mode === "automatic" ? { autoPreset: preset } : {}),
  };
}

function contentTokens(content: ChatMessage["content"]): { tokens: number; attachments: number } {
  if (typeof content === "string") return { tokens: Math.ceil(content.length / 4), attachments: 0 };
  if (!Array.isArray(content)) return { tokens: 0, attachments: 0 };
  let tokens = 0;
  let attachments = 0;
  for (const part of content) {
    if (part.type === "text") tokens += Math.ceil(part.text.length / 4);
    else {
      tokens += 4_000;
      attachments += 4_000;
    }
  }
  return { tokens, attachments };
}

function messageTokens(message: ChatMessage): { tokens: number; attachments: number } {
  const content = contentTokens(message.content);
  // Role/content framing and transport conversion add tokens not represented
  // by raw text. Deliberately conservative because the built-in estimator is
  // model-agnostic and provider tokenizers differ.
  let tokens = content.tokens + MESSAGE_WIRE_OVERHEAD_TOKENS;
  for (const call of message.tool_calls ?? []) {
    tokens += Math.ceil((call.function.name.length + call.function.arguments.length) / 4) + 4;
  }
  if (message.tool_call_id) tokens += Math.ceil(message.tool_call_id.length / 4);
  return { tokens, attachments: content.attachments };
}

function toolsTokens(tools: readonly ChatTool[]): number {
  if (tools.length === 0) return 0;
  return Math.ceil(JSON.stringify(tools).length / 4) + tools.length * 4;
}

function findCurrentUserIndex(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

function account(
  messages: readonly ChatMessage[],
  tools: readonly ChatTool[],
  budget: ContextBudget
): ContextAccounting {
  const currentUserIndex = findCurrentUserIndex(messages);
  let systemTokens = 0;
  let currentUserTokens = 0;
  let historyTokens = 0;
  let attachmentTokens = 0;
  for (let i = 0; i < messages.length; i++) {
    const cost = messageTokens(messages[i]);
    attachmentTokens += cost.attachments;
    if (messages[i].role === "system") systemTokens += cost.tokens;
    else if (i === currentUserIndex) currentUserTokens += cost.tokens;
    else historyTokens += cost.tokens;
  }
  const toolDefinitionTokens = toolsTokens(tools);
  const totalInputTokens = systemTokens + currentUserTokens + historyTokens + toolDefinitionTokens;
  return {
    systemTokens,
    currentUserTokens,
    historyTokens,
    toolDefinitionTokens,
    attachmentTokens,
    totalInputTokens,
    reservedOutputTokens: budget.reservedOutputTokens,
    safetyMarginTokens: budget.safetyMarginTokens,
    totalContextTokens: totalInputTokens + budget.reservedOutputTokens + budget.safetyMarginTokens,
  };
}

/** Build removable, structurally complete history groups. System messages and
 * latest user request are protected. A user turn includes following assistant
 * and tool messages until the next user turn; standalone tool exchanges stay
 * together. */
function removableGroups(messages: readonly ChatMessage[], currentUserIndex: number): number[][] {
  const groups: number[][] = [];
  let group: number[] = [];
  const flush = () => {
    if (group.length > 0) groups.push(group);
    group = [];
  };
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "system" || i === currentUserIndex) {
      flush();
      continue;
    }
    if (messages[i].role === "user") flush();
    group.push(i);
  }
  flush();
  return groups;
}

export function enforceContextBudget(input: {
  messages: readonly ChatMessage[];
  tools?: readonly ChatTool[];
  budget: ContextBudget;
}): {
  messages: ChatMessage[];
  tools: ChatTool[];
  budget: ContextBudget;
  accounting: ContextAccounting;
  droppedMessageIndexes: number[];
} {
  const tools = [...(input.tools ?? [])];
  const originalMessages = [...input.messages];
  const currentUserIndex = findCurrentUserIndex(originalMessages);
  const protectedMessages = originalMessages.filter((message, index) => message.role === "system" || index === currentUserIndex);
  const protectedAccounting = account(protectedMessages, tools, input.budget);
  if (protectedAccounting.totalInputTokens > input.budget.availableInputTokens) {
    throw new ContextBudgetError(
      "PROTECTED_CONTEXT_OVERFLOW",
      "Required system, user, and tool context exceeds this model's available input budget"
    );
  }

  const dropped = new Set<number>();
  let retained = originalMessages;
  let accounting = account(retained, tools, input.budget);
  for (const group of removableGroups(originalMessages, currentUserIndex)) {
    if (accounting.totalInputTokens <= input.budget.availableInputTokens) break;
    for (const index of group) dropped.add(index);
    retained = originalMessages.filter((_message, index) => !dropped.has(index));
    accounting = account(retained, tools, input.budget);
  }
  if (accounting.totalInputTokens > input.budget.availableInputTokens) {
    throw new ContextBudgetError("PROTECTED_CONTEXT_OVERFLOW", "Required context exceeds this model's available input budget");
  }
  return {
    messages: retained,
    tools,
    budget: input.budget,
    accounting,
    droppedMessageIndexes: [...dropped].sort((a, b) => a - b),
  };
}

export function formatContextTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  if (tokens >= 1_000) return `${Number((tokens / 1_000).toFixed(1))}K`;
  return String(tokens);
}
