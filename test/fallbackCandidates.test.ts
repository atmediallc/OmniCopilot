import { describe, expect, it } from "vitest";
import { pickFallbackCandidates, transportPlanForModel } from "../src/routes";
import type { CatalogEntry, CatalogModel } from "../src/routes";

/**
 * Unit tests for the PRODUCTION fallback planner (src/routes.ts).
 *
 * NOTE: test/fallback.test.ts covers the deprecated pickFallbackModels in
 * src/client.ts; the provider actually consumes pickFallbackCandidates, so
 * these tests pin down the real chain semantics, including the "full" mode.
 */

function cat(
  routeId: string,
  routeName: string,
  modelId: string,
  toolCalling?: boolean
): CatalogModel {
  return {
    entry: { routeId, routeName, modelId, prefixedId: `${routeName} · ${modelId}` },
    model: {
      id: modelId,
      ...(toolCalling === undefined ? {} : { capabilities: { tool_calling: toolCalling } }),
    },
  };
}

const primary: CatalogEntry = {
  routeId: "A",
  routeName: "Server A",
  modelId: "openai/gpt-4o",
  prefixedId: "Server A · openai/gpt-4o",
};

describe("pickFallbackCandidates (production fallback chain)", () => {
  it('mode "none" returns no candidates', () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o"),
      cat("B", "Server B", "openai/gpt-4o"),
      cat("B", "Server B", "kimi/k2"),
    ];
    expect(pickFallbackCandidates(primary, catalog, false, "none")).toEqual([]);
  });

  it('mode "sameModel" returns only the same modelId on other routes', () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o"), // primary — excluded
      cat("B", "Server B", "openai/gpt-4o"), // same model, other route ✓
      cat("A", "Server A", "openai/gpt-4o-mini"), // other model on same route ✗
      cat("B", "Server B", "kimi/k2"), // other family ✗
    ];
    expect(pickFallbackCandidates(primary, catalog, false, "sameModel")).toEqual([
      { routeId: "B", modelId: "openai/gpt-4o", transportPlan: ["responses", "chatCompletions"] },
    ]);
  });

  it('mode "sameFamily" adds other models of the same family on the SAME route', () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o"),
      cat("B", "Server B", "openai/gpt-4o"),
      cat("A", "Server A", "openai/gpt-4o-mini"), // same route, same family ✓
      cat("A", "Server A", "anthropic/claude-3-5-sonnet"), // same route, other family ✗
      cat("B", "Server B", "kimi/k2"), // other route+family ✗
    ];
    expect(pickFallbackCandidates(primary, catalog, false, "sameFamily")).toEqual([
      { routeId: "B", modelId: "openai/gpt-4o", transportPlan: ["responses", "chatCompletions"] },
      { routeId: "A", modelId: "openai/gpt-4o-mini", transportPlan: ["responses", "chatCompletions"] },
    ]);
  });

  it('mode "sameFamily" with an unknown primary model does not match other unknown models', () => {
    const unknownPrimary: CatalogEntry = {
      routeId: "A",
      routeName: "Server A",
      modelId: "newai/neural-x-1",
      prefixedId: "Server A · newai/neural-x-1",
    };
    const catalog = [
      cat("A", "Server A", "newai/neural-x-1"),
      cat("B", "Server B", "newai/neural-x-1"), // same model, other route ✓
      cat("A", "Server A", "acme/unrelated-v2"), // other unknown model on same route ✗ (should not match as sameFamily)
    ];
    expect(pickFallbackCandidates(unknownPrimary, catalog, false, "sameFamily")).toEqual([
      { routeId: "B", modelId: "newai/neural-x-1", transportPlan: ["responses", "chatCompletions"] },
    ]);
  });

  it('mode "sameFamily" with needsTools=true rejects candidates in the same family that lack tool support', () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o"),
      cat("A", "Server A", "openai/gpt-4o-mini", false), // same family, but lacks tools ✗
    ];
    expect(pickFallbackCandidates(primary, catalog, true, "sameFamily")).toEqual([]);
  });

  it('mode "full" covers the entire compatible catalog: sameModel → sameFamily → anything', () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o"), // primary — always excluded
      cat("B", "Server B", "openai/gpt-4o"), // tier 1: same model, other route
      cat("A", "Server A", "openai/gpt-4o-mini"), // tier 2: same route+family
      cat("A", "Server A", "anthropic/claude-3-5-sonnet"), // tier 3: anything
      cat("B", "Server B", "kimi/k2"), // tier 3: anything
    ];
    expect(pickFallbackCandidates(primary, catalog, false, "full")).toEqual([
      { routeId: "B", modelId: "openai/gpt-4o", transportPlan: ["responses", "chatCompletions"] },
      { routeId: "A", modelId: "openai/gpt-4o-mini", transportPlan: ["responses", "chatCompletions"] },
      { routeId: "A", modelId: "anthropic/claude-3-5-sonnet", transportPlan: ["responses", "chatCompletions"] },
      { routeId: "B", modelId: "kimi/k2", transportPlan: ["responses", "chatCompletions"] },
    ]);
  });

  it('mode "full" with needsTools=true fails closed: keeps only explicitly tool-capable models', () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o"), // primary
      cat("B", "Server B", "openai/gpt-4o", false), // explicit false → excluded
      cat("A", "Server A", "anthropic/claude-3-5-sonnet", false), // explicit false → excluded
      cat("B", "Server B", "kimi/k2", true), // explicit true → supported ✓
      cat("C", "Server C", "mistral/mistral-7b"), // absent → excluded (fails closed)
    ];
    expect(pickFallbackCandidates(primary, catalog, true, "full")).toEqual([
      { routeId: "B", modelId: "kimi/k2", transportPlan: ["responses", "chatCompletions"] },
    ]);
  });

  it("filters out candidates when needsVision=true and candidate lacks vision", () => {
    const catalog: CatalogModel[] = [
      {
        entry: { routeId: "A", routeName: "Server A", modelId: "openai/gpt-4o", prefixedId: "Server A · openai/gpt-4o" },
        model: { id: "openai/gpt-4o", capabilities: { vision: true } },
      },
      {
        entry: { routeId: "A", routeName: "Server A", modelId: "openai/gpt-4o-mini", prefixedId: "Server A · openai/gpt-4o-mini" },
        model: { id: "openai/gpt-4o-mini", capabilities: { vision: false } },
      },
      {
        entry: { routeId: "B", routeName: "Server B", modelId: "anthropic/claude-3-5-sonnet", prefixedId: "Server B · anthropic/claude-3-5-sonnet" },
        model: { id: "anthropic/claude-3-5-sonnet", capabilities: { vision: true } },
      },
    ];
    const result = pickFallbackCandidates(primary, catalog, { needsVision: true }, "full");
    expect(result).toEqual([
      { routeId: "B", modelId: "anthropic/claude-3-5-sonnet", transportPlan: ["responses", "chatCompletions"] },
    ]);
  });

  it("filters out candidates when context_length is smaller than minContextTokens", () => {
    const catalog: CatalogModel[] = [
      {
        entry: { routeId: "A", routeName: "Server A", modelId: "openai/gpt-4o", prefixedId: "Server A · openai/gpt-4o" },
        model: { id: "openai/gpt-4o", context_length: 128_000 },
      },
      {
        entry: { routeId: "A", routeName: "Server A", modelId: "openai/gpt-4o-mini", prefixedId: "Server A · openai/gpt-4o-mini" },
        model: { id: "openai/gpt-4o-mini", context_length: 8_000 },
      },
      {
        entry: { routeId: "B", routeName: "Server B", modelId: "anthropic/claude-3-5-sonnet", prefixedId: "Server B · anthropic/claude-3-5-sonnet" },
        model: { id: "anthropic/claude-3-5-sonnet", context_length: 200_000 },
      },
    ];
    const result = pickFallbackCandidates(primary, catalog, { minContextTokens: 32_000 }, "full");
    // gpt-4o-mini has 8,000 < 32,000, so it is filtered out
    expect(result).toEqual([
      { routeId: "B", modelId: "anthropic/claude-3-5-sonnet", transportPlan: ["responses", "chatCompletions"] },
    ]);
  });

  it("filters out candidates that have an empty transport plan", () => {
    const catalog: CatalogModel[] = [
      {
        entry: { routeId: "A", routeName: "Server A", modelId: "openai/gpt-4o", prefixedId: "Server A · openai/gpt-4o" },
        model: { id: "openai/gpt-4o" },
      },
      {
        entry: { routeId: "B", routeName: "Server B", modelId: "special/audio-model", prefixedId: "Server B · special/audio-model" },
        model: { id: "special/audio-model", supported_endpoints: ["/v1/audio/transcriptions"] },
      },
      {
        entry: { routeId: "B", routeName: "Server B", modelId: "anthropic/claude-3-5-sonnet", prefixedId: "Server B · anthropic/claude-3-5-sonnet" },
        model: { id: "anthropic/claude-3-5-sonnet", supported_endpoints: ["/v1/chat/completions"] },
      },
    ];
    const result = pickFallbackCandidates(primary, catalog, false, "full");
    expect(result).toEqual([
      { routeId: "B", modelId: "anthropic/claude-3-5-sonnet", transportPlan: ["chatCompletions"] },
    ]);
  });

  it("is capped at max candidates (default 4) and never duplicates prefixedIds", () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o"),
      cat("B", "Server B", "openai/gpt-4o"),
      cat("C", "Server C", "openai/gpt-4o"),
      cat("D", "Server D", "openai/gpt-4o"),
      cat("E", "Server E", "openai/gpt-4o"),
      cat("A", "Server A", "kimi/k2"), // same prefixedId as primary? no — different model, valid
    ];
    const result = pickFallbackCandidates(primary, catalog, false, "full");
    expect(result).toHaveLength(4);
    expect(new Set(result.map((r) => `${r.routeId}\u0000${r.modelId}`)).size).toBe(4);
  });

  it("returns [] when the catalog only contains the primary", () => {
    expect(
      pickFallbackCandidates(primary, [cat("A", "Server A", "openai/gpt-4o")], false, "full")
    ).toEqual([]);
  });

  it("defaults to mode full when no mode is given (provider contract)", () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o"),
      cat("B", "Server B", "kimi/k2"),
    ];
    expect(pickFallbackCandidates(primary, catalog, false)).toEqual([
      { routeId: "B", modelId: "kimi/k2", transportPlan: ["responses", "chatCompletions"] },
    ]);
  });
});

describe("transportPlanForModel", () => {
  it.each([
    [undefined, ["responses", "chatCompletions"]],
    [[], ["responses", "chatCompletions"]],
    [["future/protocol"], ["responses", "chatCompletions"]],
    [["responses"], ["responses"]],
    [["responses", "chat/completions"], ["responses", "chatCompletions"]],
    [["responses", "messages"], ["responses", "messages"]],
    [["chat/completions"], ["chatCompletions"]],
    [["messages"], ["messages"]],
    [["completions"], []],
    [["search", "/messages/count_tokens"], []],
  ] as const)("derives %j as the exact pre-output plan %j", (supported_endpoints, expected) => {
    const source = supported_endpoints === undefined
      ? { id: "m" }
      : { id: "m", supported_endpoints: [...supported_endpoints] };
    expect(transportPlanForModel(source)).toEqual(expected);
  });
});