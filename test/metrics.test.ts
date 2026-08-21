import { describe, expect, it, beforeEach } from "vitest";
import { MetricsTracker, fmtTokens } from "../src/metrics";
import { estimateTokens } from "../src/convert";
import type { Route } from "../src/routes";

function mockContext() {
  const store = new Map<string, unknown>();
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
