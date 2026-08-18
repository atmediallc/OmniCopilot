import { describe, expect, it } from "vitest";
import { isChatModel, selectChatModels } from "../src/catalogFilter";
import type { OmniRouteModel } from "../src/types";

function model(patch: Partial<OmniRouteModel> & { id: string }): OmniRouteModel {
  return { id: patch.id, ...patch };
}

describe("isChatModel", () => {
  it("keeps an untyped model with no supported_endpoints declared", () => {
    expect(isChatModel(model({ id: "claude-3-5-sonnet" }))).toBe(true);
  });

  it("keeps an explicit chat model", () => {
    expect(isChatModel(model({ id: "gpt-4o", type: "chat" }))).toBe(true);
  });

  it("drops a specialty non-chat model (image, audio, embedding, rerank, video, moderation)", () => {
    expect(isChatModel(model({ id: "dall-e-3", type: "image" }))).toBe(false);
    expect(isChatModel(model({ id: "text-embedding-3-small", type: "embeddings" }))).toBe(false);
    expect(isChatModel(model({ id: "whisper-1", type: "audio" }))).toBe(false);
    expect(isChatModel(model({ id: "bge-reranker-large", type: "rerank" }))).toBe(false);
  });

  it("keeps a Responses-API model — OmniRoute translates it for chat", () => {
    expect(isChatModel(model({ id: "cx/gpt-5.6-sol-low", supported_endpoints: ["responses"] }))).toBe(true);
  });

  it("keeps a multi-surface model as long as one surface is conversational", () => {
    expect(isChatModel(model({ id: "m", supported_endpoints: ["chat", "responses"] }))).toBe(true);
  });

  it("drops an untyped row that declares only non-conversational surfaces", () => {
    expect(isChatModel(model({ id: "x/embed", supported_endpoints: ["embeddings"] }))).toBe(false);
  });

  it("still drops a typed specialty row even if it claims a chat surface", () => {
    expect(isChatModel(model({ id: "x/img", type: "image", supported_endpoints: ["chat"] }))).toBe(false);
  });

  it("keeps a model with an empty endpoint list rather than guessing it is unusable", () => {
    expect(isChatModel(model({ id: "m", supported_endpoints: [] }))).toBe(true);
  });
});

describe("selectChatModels", () => {
  it("filters out non-chat models and duplicate prefix mirrors", () => {
    const raw: OmniRouteModel[] = [
      model({ id: "cc/claude-sonnet-4-6" }),
      model({ id: "claude/claude-sonnet-4-6", parent: "cc/claude-sonnet-4-6" }),
      model({ id: "dall-e-3", type: "image" }),
      model({ id: "gpt-4o" }),
    ];
    const filtered = selectChatModels(raw);
    expect(filtered.map((m) => m.id)).toEqual(["cc/claude-sonnet-4-6", "gpt-4o"]);
  });
});
