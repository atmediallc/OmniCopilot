/**
 * Model identity, family classification, and provider disambiguation.
 *
 * Keeps distinct concepts strictly separate:
 * - `rawId`: the exact string sent over the wire to upstream APIs (never mutated).
 * - `normalizedId`: trimmed/parsing-safe form.
 * - `provider`: the publisher / vendor namespace (e.g. "openai", "anthropic", "meta-llama").
 * - `baseModel`: the un-namespaced model name (e.g. "gpt-4o", "claude-3-7-sonnet").
 * - `family`: the genuine architectural model line (e.g. "gpt-4o", "claude", "gemini", "deepseek").
 *   Undefined for unknown or custom models — never fabricated.
 * - `displayFamily`: safe non-empty grouping label for UI dropdowns (e.g. VS Code API).
 */

export interface ModelIdentity {
  /** Exact raw model identifier as provided by the upstream route/registry. Never mutated. */
  readonly rawId: string;
  /** Normalized, trimmed identifier used for parsing and matching. */
  readonly normalizedId: string;
  /** Provider/vendor namespace prefix if present in the identifier or metadata. */
  readonly provider?: string;
  /** Base model name with provider namespaces and tags stripped. */
  readonly baseModel: string;
  /** Architectural model family if recognized with high confidence; undefined if unknown. */
  readonly family?: string;
  /** Display-only family label for UI pickers (guaranteed string; isolated from routing). */
  readonly displayFamily: string;
}

/** Non-model keywords and proxy markers that must not trigger family classification. */
const PROXY_OR_WRAPPER_PATTERNS: readonly RegExp[] = [
  /[-_]?(?:proxy|wrapper|adapter|emulator|mock|tokenizer|evaluator|test)$/i,
  /^(?:not-really|not|fake)-/i,
];

/** Routing and gateway namespaces that must be excluded when determining provider. */
const ROUTER_NAMESPACES = new Set([
  "omniroute",
  "router",
  "routers",
  "route",
  "routes",
  "alias",
  "aliases",
  "endpoint",
  "endpoints",
  "v1",
  "custom",
  "proxy",
]);

/** Known model providers for unambiguous provider extraction from path segments. */
const KNOWN_PROVIDERS = new Set([
  "openai",
  "anthropic",
  "google",
  "meta",
  "meta-llama",
  "mistralai",
  "mistral",
  "deepseek",
  "deepseek-ai",
  "qwen",
  "cohere",
  "moonshot",
  "zhipu",
  "xai",
  "microsoft",
  "amazon",
  "bedrock",
  "azure",
  "groq",
  "cerebras",
  "together",
  "fireworks",
  "minimax",
  "nvidia",
  "databricks",
]);

/** Explicit family definitions matching the base model name only.
 * Order matters for overlapping prefixes (e.g. gpt-4o before gpt-4, gpt-3.5 before gpt-3). */
const FAMILY_RULES: readonly { readonly family: string; readonly pattern: RegExp }[] = [
  // Claude
  { family: "claude", pattern: /^claude(?:[-_.]|$)/i },
  // GPT-4o / ChatGPT-4o
  { family: "gpt-4o", pattern: /^(?:chat)?gpt-4o(?:[-_.]|$)/i },
  // GPT-4 (excluding 4o)
  { family: "gpt-4", pattern: /^(?:chat)?gpt-4(?:[-_.]|$)/i },
  // GPT-3.5
  { family: "gpt-3.5", pattern: /^(?:chat)?gpt-3\.5(?:[-_.]|$)/i },
  // GPT-3 (legacy, distinct from 3.5)
  { family: "gpt-3", pattern: /^(?:chat)?gpt-3(?:[-_.]|$)/i },
  // GPT-5 / future GPT series
  { family: "gpt-5", pattern: /^(?:chat)?gpt-5(?:[-_.]|$)/i },
  // OpenAI o-series (o1, o3, o4...)
  { family: "o1", pattern: /^o1(?:[-_.]|$)/i },
  { family: "o3", pattern: /^o3(?:[-_.]|$)/i },
  { family: "o4", pattern: /^o4(?:[-_.]|$)/i },
  // Gemini
  { family: "gemini", pattern: /^gemini(?:[-_.]|$)/i },
  // DeepSeek
  { family: "deepseek", pattern: /^deepseek(?:[-_.]|$)/i },
  // Qwen
  { family: "qwen", pattern: /^qwen(?:[-_.]|$)/i },
  // LLaMA
  { family: "llama", pattern: /^(?:meta-)?llama(?:[-_.]|$)/i },
  // Mistral & Codestral
  { family: "codestral", pattern: /^codestral(?:[-_.]|$)/i },
  { family: "mistral", pattern: /^mistral(?:[-_.]|$)/i },
  // GLM
  { family: "glm", pattern: /^(?:chat)?glm(?:[-_.]|$)/i },
  // Kimi / Moonshot
  { family: "kimi", pattern: /^(?:kimi|moonshot)(?:[-_.]|$)/i },
  // Grok
  { family: "grok", pattern: /^grok(?:[-_.]|$)/i },
  // Phi (Microsoft, bounded to prevent false positives with "delphi", etc.)
  { family: "phi", pattern: /^phi(?:[-_.]|$)/i },
  // Cohere Command
  { family: "command", pattern: /^command(?:[-_.]|$)/i },
  // NVIDIA Nemotron
  { family: "nemotron", pattern: /^nemotron(?:[-_.]|$)/i },
  // MiniMax
  { family: "minimax", pattern: /^minimax(?:[-_.]|$)/i },
];

/** Sanitizes and splits a model identifier into path segments and base model name. */
function decomposeModelId(normalizedId: string): { segments: string[]; baseModel: string } {
  if (!normalizedId) {
    return { segments: [], baseModel: "" };
  }
  const segments = normalizedId
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (segments.length === 0) {
    return { segments: [], baseModel: "" };
  }

  const rawBase = segments[segments.length - 1] ?? "";
  const tagIndex = rawBase.lastIndexOf(":");
  const baseModel = tagIndex > 0 ? rawBase.slice(0, tagIndex) : rawBase;

  return { segments, baseModel };
}

/** Determines whether a string is a proxy/wrapper/mock rather than a genuine model. */
function isProxyOrWrapper(name: string): boolean {
  return PROXY_OR_WRAPPER_PATTERNS.some((p) => p.test(name));
}

/** Extracts provider from path segments or metadata, ignoring router namespaces. */
function extractProvider(segments: string[], ownedBy?: string): string | undefined {
  if (segments.length > 1) {
    const parentSegments = segments.slice(0, segments.length - 1).reverse();
    // 1. If any parent segment matches a known provider, use it.
    for (const rawSeg of parentSegments) {
      const seg = rawSeg.toLowerCase();
      if (KNOWN_PROVIDERS.has(seg)) {
        return seg;
      }
    }
    // 2. Otherwise use the closest non-router segment.
    for (const rawSeg of parentSegments) {
      const seg = rawSeg.toLowerCase();
      if (!ROUTER_NAMESPACES.has(seg)) {
        return seg;
      }
    }
  }

  if (ownedBy && ownedBy !== "system" && ownedBy !== "custom" && ownedBy !== "combo") {
    const trimmed = ownedBy.trim().toLowerCase();
    if (trimmed.length > 0 && !ROUTER_NAMESPACES.has(trimmed)) {
      return trimmed;
    }
  }

  return undefined;
}

/**
 * Resolves full model identity from a model ID and optional owner metadata.
 * Keeps exact rawId, provider, baseModel, and family strictly distinct.
 */
export function parseModelIdentity(modelId: string, ownedBy?: string): ModelIdentity {
  const rawId = typeof modelId === "string" ? modelId : "";
  const normalizedId = rawId.trim();
  const { segments, baseModel } = decomposeModelId(normalizedId);
  const provider = extractProvider(segments, ownedBy);

  // If the baseModel itself is a proxy/wrapper/test emulator, it is not a real family.
  if (!baseModel || isProxyOrWrapper(baseModel)) {
    const displayFamily = provider ?? (baseModel ? baseModel.toLowerCase() : "custom");
    return {
      rawId,
      normalizedId,
      provider,
      baseModel,
      family: undefined,
      displayFamily,
    };
  }

  // Match against known family rules ONLY on the base model name (never on arbitrary route paths).
  let family: string | undefined;
  for (const rule of FAMILY_RULES) {
    if (rule.pattern.test(baseModel)) {
      family = rule.family;
      break;
    }
  }

  // Derive display family for UI grouping: known family > provider > baseModel > "custom".
  const displayFamily = family ?? provider ?? (baseModel ? baseModel.toLowerCase() : "custom");

  return {
    rawId,
    normalizedId,
    provider,
    baseModel,
    family,
    displayFamily,
  };
}

/**
 * True architectural model family.
 * Returns undefined for unknown, unclassified, or proxy models. Never returns "omniroute".
 */
export function canonicalModelFamily(modelId: string, ownedBy?: string): string | undefined {
  return parseModelIdentity(modelId, ownedBy).family;
}

/**
 * Safe, non-empty display-only family label for UI pickers and categories.
 * Guaranteed to return a non-empty string. Never returns "omniroute".
 */
export function displayModelFamily(modelId: string, ownedBy?: string): string {
  return parseModelIdentity(modelId, ownedBy).displayFamily;
}
