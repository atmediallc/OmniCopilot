import { describe, expect, it } from "vitest";
import { pickFallbackModels } from "../src/client";
import type { OmniRouteModel } from "../src/types";

function model(id: string, toolCalling?: boolean): OmniRouteModel {
  return {
    id,
    ...(toolCalling === undefined ? {} : { capabilities: { tool_calling: toolCalling } }),
  };
}

describe("pickFallbackModels", () => {
  it("prefers the same provider family and excludes the primary", () => {
    const catalog = [model("openai/gpt-4o"), model("openai/gpt-4o-mini"), model("kimi/k2")];
    const result = pickFallbackModels("openai/gpt-4o", catalog, false);
    expect(result.map((m) => m.id)).toEqual(["openai/gpt-4o-mini"]);
  });

  it("excludes models without tool_calling when tools are needed", () => {
    const catalog = [
      model("openai/gpt-4o", true),
      model("openai/gpt-4o-mini", false),
      model("openai/gpt-4o-turbo"),
    ];
    const result = pickFallbackModels("openai/gpt-4o", catalog, true);
    // gpt-4o-mini is filtered out (tool_calling:false); the id without a
    // capabilities field is treated as supporting tools (agent mode default).
    expect(result.map((m) => m.id)).toEqual(["openai/gpt-4o-turbo"]);
  });

  it("falls back to another family when the same family has no candidate", () => {
    const catalog = [model("openai/gpt-4o"), model("kimi/k2")];
    const result = pickFallbackModels("openai/gpt-4o", catalog, false);
    expect(result.map((m) => m.id)).toEqual(["kimi/k2"]);
  });

  it("caps the result at the requested max", () => {
    const catalog = [
      model("openai/gpt-4o"),
      model("openai/gpt-4o-mini"),
      model("openai/gpt-4o-1"),
      model("openai/gpt-4o-2"),
    ];
    const result = pickFallbackModels("openai/gpt-4o", catalog, false, 2);
    expect(result.map((m) => m.id)).toEqual(["openai/gpt-4o-mini", "openai/gpt-4o-1"]);
  });

  it("returns nothing for an empty catalog", () => {
    expect(pickFallbackModels("openai/gpt-4o", [], false)).toEqual([]);
  });

  it("returns nothing when only the primary exists", () => {
    expect(pickFallbackModels("openai/gpt-4o", [model("openai/gpt-4o")], false)).toEqual([]);
  });
});
