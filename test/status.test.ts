import { describe, expect, it } from "vitest";
import {
  renderStatusText,
  statusColorTokens,
  type StatusSnapshot,
} from "../src/status/statusRenderer";
import { buildStatusTooltip } from "../src/status/statusTooltip";

const base: StatusSnapshot = {
  status: "online",
  servers: [
    { routeId: "a", name: "Alpha", online: true, latencyMs: 12, tokens: 0, requests: 0 },
    { routeId: "b", name: "Beta", online: false, latencyMs: 900, tokens: 100, requests: 2 },
  ],
  activeRequestCount: 0,
  fallbackCount: 0,
};

describe("statusRenderer", () => {
  it("renders server tally only", () => {
    expect(renderStatusText(base)).toBe("$(circle-filled) OmniRoute 1/2");
  });

  it("shows streaming icon while generating", () => {
    const snap: StatusSnapshot = {
      ...base,
      status: "streaming",
      activeRequestCount: 1,
      activeModel: "openai/gpt-4o",
    };
    const text = renderStatusText(snap);
    expect(text).toContain("$(loading~spin)");
    expect(text).toContain("OmniRoute 1/2");
  });

  it("uses the error icon on failure and the outline icon when offline", () => {
    expect(renderStatusText({ ...base, status: "error" })).toMatch(/^\$\(error\)/);
    expect(renderStatusText({ ...base, status: "offline", servers: [] })).toBe(
      "$(circle-outline) OmniRoute"
    );
  });

  it("maps theme-color tokens per state", () => {
    expect(statusColorTokens({ ...base })).toEqual({ color: "testing.iconPassed" });
    expect(statusColorTokens({ ...base, status: "partial" })).toEqual({
      color: "testing.iconWarning",
    });
    expect(statusColorTokens({ ...base, status: "offline" })).toEqual({
      background: "statusBarItem.warningBackground",
    });
    expect(statusColorTokens({ ...base, status: "error" })).toEqual({
      color: "testing.iconFailed",
    });
    expect(statusColorTokens({ ...base, status: "checking" })).toEqual({});
  });
});

describe("statusTooltip", () => {
  it("surfaces active request, last error and fallback count", () => {
    const snap: StatusSnapshot = {
      ...base,
      status: "error",
      lastError: "fetch failed: connect ECONNREFUSED 127.0.0.1:8080",
      activeRequestCount: 1,
      activeModel: "openai/gpt-4o",
      fallbackCount: 2,
    };
    const md = buildStatusTooltip(snap, "OmniRoute request failed.", {
      totalTokens: 10,
      totalInputTokens: 4,
      totalOutputTokens: 6,
      totalRequests: 1,
    });
    const text = md.value;
    expect(text).toContain("Active Request");
    expect(text).toContain("Last Error");
    expect(text).toContain("ECONNREFUSED");
    expect(text).toContain("2 fallback server");
  });

  it("omits optional sections when absent", () => {
    const md = buildStatusTooltip(
      { ...base, status: "checking", servers: [] },
      "Checking OmniRoute connection…",
      undefined
    );
    const text = md.value;
    expect(text).not.toContain("Last Error");
    expect(text).not.toContain("Connected Servers");
  });
});