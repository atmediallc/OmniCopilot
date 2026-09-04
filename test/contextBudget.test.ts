import { describe, expect, it } from "vitest";
import {
  ContextBudgetError,
  enforceContextBudget,
  normalizeProviderMaxContext,
  resolveContextBudget,
} from "../src/contextBudget";
import type { ChatMessage, ChatTool } from "../src/types";

const text = (role: ChatMessage["role"], content: string): ChatMessage => ({ role, content });
const tool = (name: string, description = ""): ChatTool => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties: { query: { type: "string" } } } },
});

const manualBudget = (overrides: Record<string, unknown> = {}) =>
  resolveContextBudget({
    providerMaxContext: 32_000,
    fallbackMaxContext: 128_000,
    settings: { mode: "manual", maxContextTokens: 24_000 },
    requestedOutputTokens: 4_000,
    safetyMarginTokens: 1_000,
    ...overrides,
  });

describe("normalizeProviderMaxContext", () => {
  it.each([undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "uses the explicit fallback capability for invalid metadata %s",
    (providerMaxContext) => {
      expect(normalizeProviderMaxContext(providerMaxContext, 128_000)).toEqual({
        tokens: 128_000,
        source: "fallback",
      });
    }
  );

  it("keeps a positive safe integer from catalog metadata", () => {
    expect(normalizeProviderMaxContext(200_000, 128_000)).toEqual({
      tokens: 200_000,
      source: "catalog",
    });
  });

  it("rejects an invalid fallback instead of treating the provider as unlimited", () => {
    expect(() => normalizeProviderMaxContext(undefined, 0)).toThrow(ContextBudgetError);
  });
});

describe("resolveContextBudget", () => {
  it("enforces the canonical manual-mode limits and exact available-input equation", () => {
    const budget = manualBudget();

    expect(budget).toMatchObject({
      providerMaxContext: 32_000,
      configuredMaxContext: 24_000,
      effectiveMaxContext: 24_000,
      reservedOutputTokens: 4_000,
      safetyMarginTokens: 1_000,
      availableInputTokens: 19_000,
      providerLimitSource: "catalog",
      configuredLimitClamped: false,
    });
    expect(budget.effectiveMaxContext).toBeLessThanOrEqual(budget.configuredMaxContext);
    expect(budget.configuredMaxContext).toBeLessThanOrEqual(budget.providerMaxContext);
  });

  it("clamps a saved ceiling when provider metadata shrinks and reports correction", () => {
    expect(manualBudget({
      providerMaxContext: 16_000,
      settings: { mode: "manual", maxContextTokens: 24_000 },
    })).toMatchObject({
      providerMaxContext: 16_000,
      configuredMaxContext: 16_000,
      effectiveMaxContext: 16_000,
      configuredLimitClamped: true,
      correctedMaxContextTokens: 16_000,
    });
  });

  it("clamps output reserve so safety margin leaves a non-negative input budget", () => {
    expect(manualBudget({
      providerMaxContext: 8_000,
      settings: { mode: "manual", maxContextTokens: 8_000 },
      requestedOutputTokens: 20_000,
      safetyMarginTokens: 1_000,
    })).toMatchObject({
      effectiveMaxContext: 8_000,
      reservedOutputTokens: 7_000,
      safetyMarginTokens: 1_000,
      availableInputTokens: 0,
      outputLimitClamped: true,
    });
  });

  it.each([
    { preset: "conservative", expectedInput: 11_000 },
    { preset: "balanced", expectedInput: 19_000 },
    { preset: "maximum", expectedInput: 27_000 },
  ])("resolves automatic $preset preset with token-based headroom", ({ preset, expectedInput }) => {
    const budget = resolveContextBudget({
      providerMaxContext: 32_000,
      fallbackMaxContext: 128_000,
      settings: { mode: "automatic", autoPreset: preset },
      requestedOutputTokens: 4_000,
      safetyMarginTokens: 1_000,
    });

    expect(budget.availableInputTokens).toBe(expectedInput);
    expect(budget.effectiveMaxContext).toBe(expectedInput + 5_000);
  });

  it("uses fallback capability visibly when catalog context is absent", () => {
    expect(manualBudget({ providerMaxContext: undefined })).toMatchObject({
      providerMaxContext: 128_000,
      providerLimitSource: "fallback",
    });
  });
});

describe("enforceContextBudget", () => {
  it("keeps system instructions and newest user request while dropping oldest complete history first", () => {
    const messages: ChatMessage[] = [
      text("system", "s".repeat(80)),
      text("user", "old-user-" + "x".repeat(160)),
      text("assistant", "old-answer-" + "y".repeat(160)),
      text("user", "newer-user-" + "a".repeat(80)),
      text("assistant", "newer-answer-" + "b".repeat(80)),
      text("user", "current-request-" + "z".repeat(80)),
    ];

    const result = enforceContextBudget({
      messages,
      tools: [],
      budget: manualBudget({
        providerMaxContext: 220,
        settings: { mode: "manual", maxContextTokens: 220 },
        requestedOutputTokens: 40,
        safetyMarginTokens: 20,
      }),
    });

    expect(result.messages[0]).toEqual(messages[0]);
    expect(result.messages.at(-1)).toEqual(messages.at(-1));
    expect(result.messages).not.toContainEqual(messages[1]);
    expect(result.messages).not.toContainEqual(messages[2]);
    expect(result.messages).toContainEqual(messages[3]);
    expect(result.messages).toContainEqual(messages[4]);
    expect(result.droppedMessageIndexes).toEqual([1, 2]);
    expect(result.accounting.totalInputTokens).toBeLessThanOrEqual(result.budget.availableInputTokens);
  });

  it("keeps an assistant tool call and matching result atomic when retained", () => {
    const assistantCall: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"src/a.ts"}' },
      }],
    };
    const resultMessage: ChatMessage = { role: "tool", content: "contents", tool_call_id: "call-1" };
    const messages = [
      text("system", "rules"),
      text("user", "old"),
      assistantCall,
      resultMessage,
      text("user", "current"),
    ];

    const result = enforceContextBudget({ messages, tools: [], budget: manualBudget() });

    expect(result.messages).toContainEqual(assistantCall);
    expect(result.messages).toContainEqual(resultMessage);
    expect(result.messages.findIndex((message: ChatMessage) => message === assistantCall) + 1)
      .toBe(result.messages.findIndex((message: ChatMessage) => message === resultMessage));
  });

  it("drops a complete tool exchange together rather than orphaning either side", () => {
    const assistantCall: ChatMessage = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call-1", type: "function", function: { name: "search", arguments: '{"q":"x"}' } }],
    };
    const resultMessage: ChatMessage = {
      role: "tool",
      content: "r".repeat(400),
      tool_call_id: "call-1",
    };
    const messages = [text("system", "rules"), assistantCall, resultMessage, text("user", "current")];

    const result = enforceContextBudget({
      messages,
      tools: [],
      budget: manualBudget({
        providerMaxContext: 120,
        settings: { mode: "manual", maxContextTokens: 120 },
        requestedOutputTokens: 32,
        safetyMarginTokens: 16,
      }),
    });

    expect(result.messages).not.toContainEqual(assistantCall);
    expect(result.messages).not.toContainEqual(resultMessage);
    expect(result.droppedMessageIndexes).toEqual([1, 2]);
  });

  it("accounts separately for tools, attachments, history, protected input, output reserve, and safety margin", () => {
    const image: ChatMessage = {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
    };
    const result = enforceContextBudget({
      messages: [text("system", "rules"), text("user", "history"), image, text("user", "current")],
      tools: [tool("search", "searches the web")],
      budget: manualBudget(),
    });

    expect(result.accounting).toMatchObject({
      reservedOutputTokens: 4_000,
      safetyMarginTokens: 1_000,
    });
    expect(result.accounting.systemTokens).toBeGreaterThan(0);
    expect(result.accounting.currentUserTokens).toBeGreaterThan(0);
    expect(result.accounting.historyTokens).toBeGreaterThan(0);
    expect(result.accounting.toolDefinitionTokens).toBeGreaterThan(0);
    expect(result.accounting.attachmentTokens).toBeGreaterThan(0);
    expect(result.accounting.totalContextTokens).toBe(
      result.accounting.totalInputTokens + 4_000 + 1_000
    );
  });

  it("throws a typed overflow without slicing protected JSON, code, or newest-user content", () => {
    const protectedRequest = '```json\n{"unchanged":"' + "x".repeat(800) + '"}\n```';
    const messages = [text("system", "mandatory rules"), text("user", protectedRequest)];

    let thrown: unknown;
    try {
      enforceContextBudget({
        messages,
        tools: [tool("required_tool", "d".repeat(400))],
        budget: manualBudget({
          providerMaxContext: 100,
          settings: { mode: "manual", maxContextTokens: 100 },
          requestedOutputTokens: 32,
          safetyMarginTokens: 16,
        }),
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ContextBudgetError);
    expect(thrown).toMatchObject({ code: "PROTECTED_CONTEXT_OVERFLOW" });
    expect(messages[1].content).toBe(protectedRequest);
  });
});
