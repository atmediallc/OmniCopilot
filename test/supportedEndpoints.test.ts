import { describe, expect, it } from "vitest";
import {
  classifySupportedEndpoint,
  classifySupportedEndpoints,
  normalizeSupportedEndpoint,
  transportSurfaceLabel,
} from "../src/supportedEndpoints";

describe("normalizeSupportedEndpoint", () => {
  it.each([
    [" responses ", "/responses"],
    ["///V1//RESPONSES///", "/responses"],
    ["POST /v1/responses?stream=true#event", "/responses"],
    ["https://api.example.test/v1/chat/completions?beta=1#docs", "/chat/completions"],
    ["pOsT HTTPS://api.example.test//v1//messages/", "/messages"],
  ])("normalizes %j to %j", (raw, expected) => {
    expect(normalizeSupportedEndpoint(raw)).toBe(expected);
  });

  it.each([undefined, null, 42, true, {}, ["responses"]])(
    "rejects non-string endpoint metadata %j instead of coercing it",
    (raw) => {
      expect(normalizeSupportedEndpoint(raw)).toBe("");
      expect(classifySupportedEndpoint(raw)).toBe("unknown");
    }
  );
});

describe("classifySupportedEndpoint", () => {
  it.each([
    ["responses", "responses"],
    ["/v1/chat/completions", "chatCompletions"],
    ["POST completions", "completions"],
    ["https://api.anthropic.test/v1/messages", "messages"],
    ["search", "specialty"],
    ["/v1/rerank", "specialty"],
    ["/messages/count_tokens", "specialty"],
    ["/search/analytics", "specialty"],
  ] as const)("distinguishes %j as %j", (raw, expected) => {
    expect(classifySupportedEndpoint(raw)).toBe(expected);
  });

  it.each([
    "audio",
    "image",
    "video",
    "moderation",
    "tts",
    "stt",
    "speech",
    "transcription",
    "translation",
    "/v1/embeddings",
    "/v1/images/generations",
    "/v1/audio/speech",
    "/v1/audio/transcriptions",
    "/v1/audio/translations",
    "/v1/moderations",
    "/v1/videos/generations",
  ])("classifies the full specialty path %j", (raw) => {
    expect(classifySupportedEndpoint(raw)).toBe("specialty");
  });

  it.each([
    "chat/completions-evil",
    "notresponses",
    "/proxy/v1/chat/completions",
    "/v1/messages/archive",
    "https://example.test/v1/reranker",
    "research",
  ])("leaves the deceptive substring %j unknown", (raw) => {
    expect(classifySupportedEndpoint(raw)).toBe("unknown");
  });
});

describe("classifySupportedEndpoints", () => {
  it("retains every exact recognized class and records unknown values", () => {
    expect(
      classifySupportedEndpoints([
        "POST /v1/responses",
        "chat/completions",
        "completions",
        "messages",
        "rerank",
        "chat/completions-preview",
      ])
    ).toEqual(
      new Set(["responses", "chatCompletions", "completions", "messages", "specialty", "unknown"])
    );
  });

  it("rejects invalid entries from a list instead of letting them add unknown compatibility", () => {
    expect(classifySupportedEndpoints(["/search", 42, null])).toEqual(new Set(["specialty"]));
  });
});

describe("transportSurfaceLabel", () => {
  it("labels the full compatibility plan in order", () => {
    expect(transportSurfaceLabel(["responses", "chatCompletions"])).toBe("Responses/Chat");
  });

  it.each([
    [["messages"], "Messages"],
    [["chatCompletions"], "Chat"],
    [["responses", "messages"], "Responses/Messages"],
    [["chatCompletions", "messages"], "Chat/Messages"],
  ] as const)("labels %j as %j", (plan, expected) => {
    expect(transportSurfaceLabel(plan)).toBe(expected);
  });

  it("marks an unusable model instead of hiding its incompatibility", () => {
    expect(transportSurfaceLabel([])).toBe("no compatible");
  });
});
