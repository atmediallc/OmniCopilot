import { describe, expect, it } from "vitest";
import { isChatModel, selectChatModels } from "../src/catalogFilter";
import type { OmniRouteModel } from "../src/types";

const model = (over: Partial<OmniRouteModel> & { id: string }): OmniRouteModel => over;

describe("isChatModel", () => {
  it("keeps rows with no type — that is how OmniRoute marks chat models", () => {
    expect(isChatModel(model({ id: "cc/claude-sonnet-4-6" }))).toBe(true);
  });

  it('keeps an explicit type "chat" (and ignores case/padding)', () => {
    expect(isChatModel(model({ id: "a", type: "chat" }))).toBe(true);
    expect(isChatModel(model({ id: "b", type: " Chat " }))).toBe(true);
  });

  it("drops specialty registries that cannot answer a chat request", () => {
    for (const type of ["audio", "image", "embedding", "rerank", "video", "moderation"]) {
      expect(isChatModel(model({ id: `x/${type}`, type }))).toBe(false);
    }
  });

  it("drops a model whose supported_endpoints excludes chat", () => {
    expect(isChatModel(model({ id: "openai/whisper-1", supported_endpoints: ["audio"] }))).toBe(
      false
    );
  });

  it("keeps a multi-surface model as long as chat is among its endpoints", () => {
    expect(isChatModel(model({ id: "m", supported_endpoints: ["chat", "responses"] }))).toBe(true);
  });

  it("keeps a model with an empty endpoint list rather than guessing it is unusable", () => {
    expect(isChatModel(model({ id: "m", supported_endpoints: [] }))).toBe(true);
  });
});

describe("selectChatModels", () => {
  it("drops the canonical mirror emitted by dual prefix mode", () => {
    const models = [
      model({ id: "cc/claude-sonnet-4-6", parent: null }),
      model({ id: "claude/claude-sonnet-4-6", parent: "cc/claude-sonnet-4-6" }),
    ];
    expect(selectChatModels(models).map((m) => m.id)).toEqual(["cc/claude-sonnet-4-6"]);
  });

  it("keeps a row whose parent is not itself listed — never lose a model", () => {
    const models = [model({ id: "solo/model", parent: "absent/model" })];
    expect(selectChatModels(models).map((m) => m.id)).toEqual(["solo/model"]);
  });

  it("keeps a row that points at itself", () => {
    const models = [model({ id: "self/model", parent: "self/model" })];
    expect(selectChatModels(models).map((m) => m.id)).toEqual(["self/model"]);
  });

  it("preserves catalog order and skips entries without an id", () => {
    const models = [
      model({ id: "a" }),
      { } as OmniRouteModel,
      model({ id: "b" }),
      model({ id: "c" }),
    ];
    expect(selectChatModels(models).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("combines both rules: specialty rows and mirrors go, chat models stay", () => {
    const models = [
      model({ id: "cc/claude-sonnet-4-6" }),
      model({ id: "claude/claude-sonnet-4-6", parent: "cc/claude-sonnet-4-6" }),
      model({ id: "openai/whisper-1", type: "audio" }),
      model({ id: "auto/best-free" }),
    ];
    expect(selectChatModels(models).map((m) => m.id)).toEqual([
      "cc/claude-sonnet-4-6",
      "auto/best-free",
    ]);
  });
});
