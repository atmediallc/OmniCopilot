import { describe, expect, it } from "vitest";
import { resolveReasoningEffort } from "../src/provider";

describe("resolveReasoningEffort", () => {
  it("returns undefined when nothing is set", () => {
    expect(resolveReasoningEffort("model", undefined, "none", true)).toBeUndefined();
  });

  it("infers effort from OmniRoute modelId suffix when no UI option is provided", () => {
    expect(resolveReasoningEffort("agy/gemini-3.6-flash-high", undefined, "none", true)).toBe("high");
    expect(resolveReasoningEffort("agy/gemini-3.6-flash-medium", undefined, "none", true)).toBe("medium");
    expect(resolveReasoningEffort("agy/gemini-3.6-flash-low", undefined, "none", true)).toBe("low");
    expect(resolveReasoningEffort("agy/gemini-3.6-flash-tiered", undefined, "none", true)).toBeUndefined();
  });

  it("inferred modelId effort overrides global config default", () => {
    expect(resolveReasoningEffort("agy/gemini-3.6-flash-high", undefined, "low", true)).toBe("high");
  });

  it("forwards explicit camelCase reasoningEffort from the UI, overriding modelId suffix", () => {
    expect(resolveReasoningEffort("agy/gemini-3.6-flash-high", { reasoningEffort: "low" }, "none", true)).toBe("low");
  });

  it("forwards explicit snake_case reasoning_effort", () => {
    expect(resolveReasoningEffort("model", { reasoning_effort: "low" }, "none", true)).toBe("low");
  });

  it("never forwards effort for non-reasoning models, even with explicit intent", () => {
    expect(resolveReasoningEffort("agy/gemini-3.6-flash-high", { reasoningEffort: "high" }, "medium", false)).toBeUndefined();
    expect(resolveReasoningEffort("model", { reasoning_effort: "low" }, "none", false)).toBeUndefined();
  });

  it("normalizes case and whitespace", () => {
    expect(resolveReasoningEffort("model", { reasoningEffort: "  HIGH " }, "none", true)).toBe("high");
  });

  it("explicit intent wins over the config fallback", () => {
    expect(resolveReasoningEffort("model", { reasoningEffort: "low" }, "high", true)).toBe("low");
  });

  it("applies the configured fallback for reasoning-capable models", () => {
    expect(resolveReasoningEffort("model", undefined, "medium", true)).toBe("medium");
    expect(resolveReasoningEffort("agy/gemini-3.6-flash-tiered", undefined, "medium", true)).toBe("medium");
  });

  it("does not apply the configured fallback to non-reasoning models", () => {
    expect(resolveReasoningEffort("model", undefined, "medium", false)).toBeUndefined();
  });

  it("does not apply the configured fallback when disabled (none)", () => {
    expect(resolveReasoningEffort("model", undefined, "none", true)).toBeUndefined();
  });

  it("drops invalid explicit values and falls back to modelId or config", () => {
    expect(resolveReasoningEffort("agy/gemini-3.6-flash-high", { reasoningEffort: "extreme" }, "none", true)).toBe("high");
    expect(resolveReasoningEffort("model", { reasoningEffort: "extreme" }, "high", true)).toBe("high");
    expect(resolveReasoningEffort("model", { reasoningEffort: "extreme" }, "none", true)).toBeUndefined();
  });

  it("drops non-string modelOptions values", () => {
    expect(resolveReasoningEffort("model", { reasoningEffort: 7 }, "none", true)).toBeUndefined();
  });

  it("forwards unknown (empty) modelOptions object harmlessly", () => {
    expect(resolveReasoningEffort("model", {}, "none", true)).toBeUndefined();
  });
});