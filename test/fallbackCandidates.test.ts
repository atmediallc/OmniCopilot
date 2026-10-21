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
  toolCalling: boolean | number = true,
  vision = true,
  contextLength = 128_000,
  supportedEndpoints?: string[]
): CatalogModel {
  return {
    entry: { routeId, routeName, modelId, prefixedId: `${routeName} · ${modelId}` },
    model: {
      id: modelId,
      context_length: contextLength,
      supported_endpoints: supportedEndpoints,
      capabilities: { tool_calling: toolCalling, vision },
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

  it('mode "sameFamily" never substitutes other models of the same family', () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o"),
      cat("B", "Server B", "openai/gpt-4o"),
      cat("A", "Server A", "openai/gpt-4o-mini"), // same route, same family — excluded under strict
      cat("A", "Server A", "anthropic/claude-3-5-sonnet"), // same route, other family ✗
      cat("B", "Server B", "kimi/k2"), // other route+family ✗
    ];
    expect(pickFallbackCandidates(primary, catalog, false, "sameFamily")).toEqual([
      { routeId: "B", modelId: "openai/gpt-4o", transportPlan: ["responses", "chatCompletions"] },
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

  it('mode "sameFamily" with needsTools=true rejects candidates that lack tool support', () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o", true),
      cat("B", "Server B", "openai/gpt-4o", false), // lacks tool support / mismatch
      cat("A", "Server A", "openai/gpt-4o-mini", false),
    ];
    expect(pickFallbackCandidates(primary, catalog, true, "sameFamily")).toEqual([]);
  });

  it('mode "full" covers only exact model ID cross-route and never substitutes other models', () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o"), // primary — always excluded
      cat("B", "Server B", "openai/gpt-4o"), // same model, other route ✓
      cat("A", "Server A", "openai/gpt-4o-mini"),
      cat("A", "Server A", "anthropic/claude-3-5-sonnet"),
      cat("B", "Server B", "kimi/k2"),
    ];
    expect(pickFallbackCandidates(primary, catalog, false, "full")).toEqual([
      { routeId: "B", modelId: "openai/gpt-4o", transportPlan: ["responses", "chatCompletions"] },
    ]);
  });

  it('mode "full" with needsTools=true fails closed: keeps only explicitly tool-capable models', () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o", true),
      cat("B", "Server B", "openai/gpt-4o", true), // tool-capable ✓
      cat("B", "Server B", "openai/gpt-4o-mini", false), // lacks tools ✗
      cat("B", "Server B", "kimi/k2", false), // lacks tools ✗
    ];
    expect(pickFallbackCandidates(primary, catalog, true, "full")).toEqual([
      { routeId: "B", modelId: "openai/gpt-4o", transportPlan: ["responses", "chatCompletions"] },
    ]);
  });

  it("retains numeric tool capability candidates with enough capacity", () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o", 64),
      cat("B", "Server B", "openai/gpt-4o", 64),
    ];
    expect(pickFallbackCandidates(primary, catalog, { needsTools: true, toolCount: 64 }, "sameModel")).toHaveLength(1);
  });

  it("rejects numeric fallback capacities smaller than the manifest", () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o", 32),
      cat("B", "Server B", "openai/gpt-4o", 32),
    ];
    expect(pickFallbackCandidates(primary, catalog, { needsTools: true, toolCount: 33 }, "sameModel")).toEqual([]);
  });

  it("filters out candidates when needsVision=true and candidate lacks vision", () => {
    const catalog: CatalogModel[] = [
      cat("A", "Server A", "openai/gpt-4o", true, true),
      cat("B", "Server B", "openai/gpt-4o", true, false),
    ];
    const result = pickFallbackCandidates(primary, catalog, { needsVision: true }, "full");
    expect(result).toEqual([]);
  });

  it("filters out candidates when context_length is smaller than minContextTokens", () => {
    const catalog: CatalogModel[] = [
      cat("A", "Server A", "openai/gpt-4o", true, true, 128_000),
      cat("B", "Server B", "openai/gpt-4o", true, true, 128_000),
    ];
    const result = pickFallbackCandidates(primary, catalog, { minContextTokens: 200_000 }, "full");
    expect(result).toEqual([]);

    const resultValid = pickFallbackCandidates(primary, catalog, { minContextTokens: 32_000 }, "full");
    expect(resultValid).toEqual([
      { routeId: "B", modelId: "openai/gpt-4o", transportPlan: ["responses", "chatCompletions"] },
    ]);
  });

  it("filters out candidates that have an empty transport plan", () => {
    const catalog: CatalogModel[] = [
      cat("A", "Server A", "openai/gpt-4o", true, true, 128_000, ["/v1/chat/completions"]),
      cat("B", "Server B", "openai/gpt-4o", true, true, 128_000, ["/v1/audio/transcriptions"]),
      cat("C", "Server C", "openai/gpt-4o", true, true, 128_000, ["/v1/chat/completions"]),
    ];
    const result = pickFallbackCandidates(primary, catalog, false, "full");
    expect(result).toEqual([
      { routeId: "C", modelId: "openai/gpt-4o", transportPlan: ["chatCompletions"] },
    ]);
  });

  it("is capped at max candidates (default 4) and never duplicates prefixedIds", () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o"),
      cat("B", "Server B", "openai/gpt-4o"),
      cat("C", "Server C", "openai/gpt-4o"),
      cat("D", "Server D", "openai/gpt-4o"),
      cat("E", "Server E", "openai/gpt-4o"),
      cat("F", "Server F", "openai/gpt-4o"),
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

  it("defaults to mode askBeforeSwitch and never substitutes other models", () => {
    const catalog = [
      cat("A", "Server A", "openai/gpt-4o"),
      cat("B", "Server B", "openai/gpt-4o"),
      cat("B", "Server B", "kimi/k2"),
    ];
    expect(pickFallbackCandidates(primary, catalog, false)).toEqual([
      { routeId: "B", modelId: "openai/gpt-4o", transportPlan: ["responses", "chatCompletions"] },
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