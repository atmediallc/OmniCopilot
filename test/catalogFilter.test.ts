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

  // Regression guard: OmniRoute lists every Codex/GPT-5.x model as
  // `supported_endpoints: ["responses"]` and translates them for
  // chat/completions. Verified live on 192.168.0.17 — `cx/gpt-5.5-low` and
  // `cx/gpt-5.6-sol-low` both answer HTTP 200. Filtering on "does not include
  // chat" would silently drop 26 usable models from the picker.
  it("keeps a Responses-API model — OmniRoute translates it for chat", () => {
    expect(isChatModel(model({ id: "cx/gpt-5.6-sol-low", supported_endpoints: ["responses"] }))).toBe(
      true
    );
  });

  it("keeps a multi-surface model as long as one surface is conversational", () => {
    expect(isChatModel(model({ id: "m", supported_endpoints: ["chat", "responses"] }))).toBe(true);
  });

  it("drops an untyped row that declares only non-conversational surfaces", () => {
    expect(isChatModel(model({ id: "x/embed", supported_endpoints: ["embeddings"] }))).toBe(false);
  });

  it("still drops a typed specialty row even if it claims a chat surface", () => {
    expect(isChatModel(model({ id: "x/img", type: "image", supported_endpoints: ["chat"] }))).toBe(
      false
    );
  });

  it("keeps a model with an empty endpoint list rather than guessing it is unusable", () => {
    expect(isChatModel(model({ id: "m", supported_endpoints: [] }))).toBe(true);
  });

  // Regression guards for server-version skew (the Ashburn failure): a server
  // running an older/newer OmniRoute build can send `type: "llm"` and
  // `supported_endpoints: ["chat/completions"]`. The filter must treat both as
  // conversational — an unknown type or a `chat`-containing surface must never
  // empty the whole route's picker.
  it('keeps a model typed "llm" — only known specialty types are dropped', () => {
    expect(isChatModel(model({ id: "ash/llama-3.3-70b", type: "llm" }))).toBe(true);
    expect(isChatModel(model({ id: "m", type: "llm", supported_endpoints: ["chat/completions"] }))).toBe(
      true
    );
  });

  it('keeps a model served on "chat/completions"', () => {
    expect(
      isChatModel(model({ id: "ash/gpt-4o-mini", supported_endpoints: ["chat/completions"] }))
    ).toBe(true);
  });

  it('keeps a model served on "completions" — not a known specialty surface', () => {
    expect(isChatModel(model({ id: "m", supported_endpoints: ["completions"] }))).toBe(true);
  });

  it("keeps a model with a wholly unknown endpoint value (future surface)", () => {
    expect(isChatModel(model({ id: "m", supported_endpoints: ["foo/bar.baz"] }))).toBe(true);
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

  // Regression guard (Ashburn failure): a broken server that advertises a
  // cyclic dual-prefix pair (A.parent = B AND B.parent = A) must not wipe the
  // catalog. The old dedup dropped both rows because each looked like a mirror.
  it("keeps both rows of a cyclic dual-prefix pair instead of dropping the catalog", () => {
    const models = [
      model({ id: "ash/prefix/model", parent: "canonical/prefix/model" }),
      model({ id: "canonical/prefix/model", parent: "ash/prefix/model" }),
    ];
    expect(selectChatModels(models).map((m) => m.id)).toEqual([
      "ash/prefix/model",
      "canonical/prefix/model",
    ]);
  });

  it("still drops a true mirror when the parent does not point back", () => {
    const models = [
      model({ id: "cc/claude-sonnet-4-6", parent: null }),
      model({ id: "claude/claude-sonnet-4-6", parent: "cc/claude-sonnet-4-6" }),
    ];
    expect(selectChatModels(models).map((m) => m.id)).toEqual(["cc/claude-sonnet-4-6"]);
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
