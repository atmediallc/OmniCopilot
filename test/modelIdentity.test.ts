import { describe, expect, it } from "vitest";
import { canonicalModelFamily, displayModelFamily, parseModelIdentity } from "../src/modelIdentity";

describe("parseModelIdentity & canonicalModelFamily architecture", () => {
  describe("known models resolution", () => {
    it("resolves Claude models", () => {
      const id = parseModelIdentity("anthropic/claude-sonnet-4");
      expect(id.family).toBe("claude");
      expect(id.provider).toBe("anthropic");
      expect(id.baseModel).toBe("claude-sonnet-4");
      expect(canonicalModelFamily("claude-3-7-sonnet")).toBe("claude");
      expect(displayModelFamily("claude-3-7-sonnet")).toBe("claude");
    });

    it("resolves GPT-4o distinctly from GPT-4", () => {
      const gpt4o = parseModelIdentity("openai/gpt-4o");
      const gpt4 = parseModelIdentity("openai/gpt-4");
      const gpt4oMini = parseModelIdentity("openai/gpt-4o-mini");
      expect(gpt4o.family).toBe("gpt-4o");
      expect(gpt4.family).toBe("gpt-4");
      expect(gpt4oMini.family).toBe("gpt-4o");
      expect(gpt4o.family).not.toBe(gpt4.family);
    });

    it("resolves GPT-3 and GPT-3.5 without conflation", () => {
      expect(canonicalModelFamily("openai/gpt-3.5-turbo")).toBe("gpt-3.5");
      expect(canonicalModelFamily("openai/gpt-3")).toBe("gpt-3");
    });

    it("resolves OpenAI o-series with dynamic extensibility", () => {
      expect(canonicalModelFamily("openai/o1")).toBe("o1");
      expect(canonicalModelFamily("openai/o1-mini")).toBe("o1");
      expect(canonicalModelFamily("openai/o3")).toBe("o3");
      expect(canonicalModelFamily("openai/o3-mini")).toBe("o3");
      expect(canonicalModelFamily("openai/o4-mini")).toBe("o4");
    });

    it("resolves major open & commercial families", () => {
      expect(canonicalModelFamily("google/gemini-2.0-flash")).toBe("gemini");
      expect(canonicalModelFamily("deepseek/deepseek-chat")).toBe("deepseek");
      expect(canonicalModelFamily("deepseek-ai/deepseek-r1")).toBe("deepseek");
      expect(canonicalModelFamily("qwen/qwen-2.5-coder-32b")).toBe("qwen");
      expect(canonicalModelFamily("meta-llama/llama-3.3-70b-instruct")).toBe("llama");
      expect(canonicalModelFamily("mistral/mistral-large")).toBe("mistral");
      expect(canonicalModelFamily("mistralai/codestral-2501")).toBe("codestral");
      expect(canonicalModelFamily("zhipu/glm-4-plus")).toBe("glm");
      expect(canonicalModelFamily("moonshot/kimi-k2")).toBe("kimi");
      expect(canonicalModelFamily("xai/grok-2-1212")).toBe("grok");
      expect(canonicalModelFamily("microsoft/phi-4")).toBe("phi");
      expect(canonicalModelFamily("cohere/command-r-plus")).toBe("command");
      expect(canonicalModelFamily("nvidia/nemotron-4-340b")).toBe("nemotron");
      expect(canonicalModelFamily("minimax/minimax-text-01")).toBe("minimax");
    });
  });

  describe("adversarial false-positive resistance", () => {
    it("does not match proxy or wrapper suffixes as target model families", () => {
      expect(canonicalModelFamily("custom/my-claude-compatible-proxy")).toBeUndefined();
      expect(canonicalModelFamily("vendor/not-gpt-4-actually")).toBeUndefined();
      expect(canonicalModelFamily("foo/gemini-wrapper")).toBeUndefined();
      expect(canonicalModelFamily("bar/llama-emulator")).toBeUndefined();
      expect(canonicalModelFamily("fake-grok-model")).toBeUndefined();
      expect(canonicalModelFamily("something/phi-tokenizer")).toBeUndefined();
    });

    it("does not false-positive match path segment router names", () => {
      expect(canonicalModelFamily("claude-router/custom/my-model")).toBeUndefined();
    });

    it("does not false-positive match phi on delphi", () => {
      expect(canonicalModelFamily("vendor/delphi-7b")).toBeUndefined();
      expect(displayModelFamily("vendor/delphi-7b")).toBe("vendor");
    });
  });

  describe("unknown model handling & zero fabricated metadata", () => {
    it("never returns omniroute for unknown models", () => {
      expect(canonicalModelFamily("vendor/unknown-model")).toBeUndefined();
      expect(canonicalModelFamily("brand-new-family/model-x")).toBeUndefined();
      expect(canonicalModelFamily("custom/private-model")).toBeUndefined();
    });

    it("honestly leaves family undefined while providing safe display grouping", () => {
      const id = parseModelIdentity("futurevendor/supermodel-x");
      expect(id.family).toBeUndefined();
      expect(id.displayFamily).toBe("futurevendor");
      expect(id.provider).toBe("futurevendor");
      expect(id.baseModel).toBe("supermodel-x");
    });

    it("derives safe display grouping for un-prefixed unknown models without omniroute fabrication", () => {
      const id = parseModelIdentity("dbrx-instruct");
      expect(id.family).toBeUndefined();
      expect(id.displayFamily).toBe("dbrx-instruct");
    });
  });

  describe("robustness with odd formatting and delimiters", () => {
    it("normalizes case-insensitively while preserving exact rawId", () => {
      const res = parseModelIdentity("  OpenAI/GPT-4O:latest  ");
      expect(res.rawId).toBe("  OpenAI/GPT-4O:latest  ");
      expect(res.normalizedId).toBe("OpenAI/GPT-4O:latest");
      expect(res.family).toBe("gpt-4o");
      expect(res.provider).toBe("openai");
      expect(res.baseModel).toBe("GPT-4O");
    });

    it("tolerates irregular slashes and whitespace", () => {
      expect(canonicalModelFamily("   openai//gpt-4o   ")).toBe("gpt-4o");
      expect(canonicalModelFamily("/openai/gpt-4o/")).toBe("gpt-4o");
      expect(canonicalModelFamily("")).toBeUndefined();
      expect(displayModelFamily("")).toBe("custom");
      expect(canonicalModelFamily("   ")).toBeUndefined();
    });

    it("handles multi-level proxy paths (e.g. openrouter/anthropic/claude-3-5)", () => {
      const res = parseModelIdentity("openrouter/anthropic/claude-3-5-sonnet");
      expect(res.family).toBe("claude");
      expect(res.provider).toBe("anthropic");
    });

    it("skips router namespaces when extracting provider", () => {
      const res = parseModelIdentity("omniroute/route-a/openai/gpt-4o");
      expect(res.provider).toBe("openai");
      expect(res.family).toBe("gpt-4o");
    });
  });

  describe("ownedBy provider disambiguation", () => {
    it("does not conflate provider/owner with model family", () => {
      const res = parseModelIdentity("custom-llm-v1", "openai");
      expect(res.provider).toBe("openai");
      expect(res.family).toBeUndefined();
      expect(res.displayFamily).toBe("openai");
    });

    it("ignores system, custom, combo owners", () => {
      expect(parseModelIdentity("my-model", "system").provider).toBeUndefined();
      expect(parseModelIdentity("my-model", "custom").provider).toBeUndefined();
      expect(parseModelIdentity("my-model", "combo").provider).toBeUndefined();
    });
  });
});
