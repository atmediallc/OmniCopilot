import { describe, expect, it, beforeEach } from "vitest";
import { MetricsTracker, fmtTokens } from "../src/metrics";
import { estimateTokens } from "../src/convert";
import type { Route } from "../src/routes";

function mockContext(initialMetrics?: unknown) {
  const store = new Map<string, unknown>();
  if (initialMetrics !== undefined) {
    store.set("omnicopilot.tokenMetrics.v1", initialMetrics);
  }
  return {
    globalState: {
      get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
  } as unknown as ConstructorParameters<typeof MetricsTracker>[0];
}

describe("fmtTokens", () => {
  it("formats tokens into readable strings", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(500)).toBe("500");
    expect(fmtTokens(1500)).toBe("1.5k");
    expect(fmtTokens(2500000)).toBe("2.50M");
  });
});

describe("estimateTokens", () => {
  it("estimates tokens correctly for text", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello world")).toBe(3);
    expect(estimateTokens("a".repeat(100))).toBe(25);
  });
});

describe("MetricsTracker", () => {
  let context: ReturnType<typeof mockContext>;
  let tracker: MetricsTracker;

  beforeEach(() => {
    context = mockContext();
    tracker = new MetricsTracker(context);
  });

  it("hydrates omitted legacy counters before recording stalls and usage", async () => {
    const legacyMetrics = {
      sessionStartTime: 1_700_000_000_000,
      totalTokens: 30,
      totalRequests: 1,
      servers: {
        "route-1": {
          routeId: "route-1",
          name: "Legacy Server",
          baseUrl: "http://legacy.local/v1",
          online: true,
          totalTokens: 30,
          requestCount: 1,
        },
      },
    };
    tracker = new MetricsTracker(mockContext(legacyMetrics));

    const hydrated = tracker.getMetrics();
    expect(hydrated).toMatchObject({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 30,
      totalRequests: 1,
      totalStalls: 0,
    });
    expect(hydrated.servers["route-1"]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 30,
      requestCount: 1,
      successCount: 0,
      errorCount: 0,
      stallCount: 0,
    });

    await tracker.recordStall("route-1", "Legacy Server", "http://legacy.local/v1");
    await tracker.recordUsage(
      "route-1",
      "Legacy Server",
      "http://legacy.local/v1",
      "openai/gpt-4o",
      12,
      8
    );

    const metrics = tracker.getMetrics();
    expect(metrics).toMatchObject({
      sessionStartTime: 1_700_000_000_000,
      totalInputTokens: 12,
      totalOutputTokens: 8,
      totalTokens: 50,
      totalRequests: 2,
      totalStalls: 1,
    });
    expect(metrics.servers["route-1"]).toMatchObject({
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 50,
      requestCount: 2,
      successCount: 1,
      errorCount: 0,
      stallCount: 1,
      lastUsedModel: "openai/gpt-4o",
    });
    expect([
      metrics.totalInputTokens,
      metrics.totalOutputTokens,
      metrics.totalTokens,
      metrics.totalRequests,
      metrics.totalStalls,
      metrics.servers["route-1"].inputTokens,
      metrics.servers["route-1"].outputTokens,
      metrics.servers["route-1"].totalTokens,
      metrics.servers["route-1"].requestCount,
      metrics.servers["route-1"].successCount,
      metrics.servers["route-1"].errorCount,
      metrics.servers["route-1"].stallCount,
    ].every(Number.isFinite)).toBe(true);
  });

  it("discards malformed containers and clamps invalid cumulative counters", () => {
    tracker = new MetricsTracker(mockContext({
      sessionStartTime: Number.POSITIVE_INFINITY,
      totalInputTokens: -1,
      totalOutputTokens: Number.NaN,
      totalTokens: 20,
      totalRequests: -4,
      totalStalls: Number.NEGATIVE_INFINITY,
      servers: [
        { routeId: "fake-array-route", totalTokens: 99 },
      ],
    }));

    const metrics = tracker.getMetrics();
    expect(metrics.totalInputTokens).toBe(0);
    expect(metrics.totalOutputTokens).toBe(0);
    expect(metrics.totalTokens).toBe(20);
    expect(metrics.totalRequests).toBe(0);
    expect(metrics.totalStalls).toBe(0);
    expect(Number.isFinite(metrics.sessionStartTime)).toBe(true);
    expect(metrics.servers).toEqual({});
  });

  it("records usage and activity while preserving server names", async () => {
    await tracker.recordUsage("route-1", "Primary Server", "http://localhost:8080", "gpt-4o", 100, 50);

    let metrics = tracker.getMetrics();
    expect(metrics.totalTokens).toBe(150);
    expect(metrics.totalInputTokens).toBe(100);
    expect(metrics.totalOutputTokens).toBe(50);
    expect(metrics.totalRequests).toBe(1);

    const server = metrics.servers["route-1"];
    expect(server).toBeDefined();
    expect(server.name).toBe("Primary Server");
    expect(server.inputTokens).toBe(100);
    expect(server.outputTokens).toBe(50);

    // Call recordActivity preserving name
    await tracker.recordActivity("route-1", "route-1", "http://localhost:8080", true);
    metrics = tracker.getMetrics();
    expect(metrics.servers["route-1"].name).toBe("Primary Server");
  });

  it("records cached and estimated tokens accurately", async () => {
    await tracker.recordUsage(
      "route-1",
      "Primary Server",
      "http://localhost:8080",
      "claude-sonnet-4-6",
      200,
      100,
      150,
      false
    );
    await tracker.recordUsage(
      "route-1",
      "Primary Server",
      "http://localhost:8080",
      "fallback-model",
      50,
      25,
      0,
      true
    );

    const metrics = tracker.getMetrics();
    expect(metrics.totalTokens).toBe(375);
    expect(metrics.totalInputTokens).toBe(250);
    expect(metrics.totalOutputTokens).toBe(125);
    expect(metrics.totalCachedTokens).toBe(150);
    expect(metrics.totalEstimatedTokens).toBe(75);

    const server = metrics.servers["route-1"];
    expect(server.cachedTokens).toBe(150);
    expect(server.estimatedTokens).toBe(75);
  });

  it("resets metrics correctly", async () => {
    await tracker.recordUsage("route-1", "Primary Server", "http://localhost:8080", "gpt-4o", 100, 50);
    await tracker.resetMetrics();

    const metrics = tracker.getMetrics();
    expect(metrics.totalTokens).toBe(0);
    expect(metrics.totalRequests).toBe(0);
    expect(Object.keys(metrics.servers)).toHaveLength(0);
  });

  it("generates suggestions for single server configuration", () => {
    const routes: Route[] = [{ id: "route-1", name: "Server 1", baseUrl: "http://localhost:8080" }];
    const suggestions = tracker.generateSuggestions(routes, new Set(["route-1"]));

    expect(suggestions.some((s) => s.id === "single_route")).toBe(true);
  });

  it("opens the dashboard from the stream stalls suggestion", async () => {
    await tracker.recordStall("route-1", "Primary Server", "http://localhost:8080");

    const suggestion = tracker
      .generateSuggestions([], new Set())
      .find((candidate) => candidate.id === "stream_stalls");

    expect(suggestion).toMatchObject({
      id: "stream_stalls",
      actionLabel: "Check Server Health",
      actionCommand: "omnicopilot.openDashboard",
    });
  });
});
