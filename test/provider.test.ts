import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { canonicalModelFamily, displayModelFamily, OmniRouteChatProvider } from "../src/provider";
import * as routesModule from "../src/routes";

function mockContext() {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
      update: async (key: string, value: unknown) => {
        store.set(key, value);
      },
    },
  } as unknown as ConstructorParameters<typeof OmniRouteChatProvider>[0]["context"];
}

const mockLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  name: "mockLog",
  loglevel: 0,
  onDidChangeLogLevel: () => ({ dispose: () => {} }),
  append: () => {},
  appendLine: () => {},
  clear: () => {},
  show: () => {},
  hide: () => {},
  dispose: () => {},
  debug: () => {},
  trace: () => {},
} as unknown as vscode.LogOutputChannel;

const dummyToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => {} }),
} as unknown as vscode.CancellationToken;

describe("OmniRouteChatProvider", () => {
  it("can be instantiated with dependencies", () => {
    const context = mockContext();
    const provider = new OmniRouteChatProvider({
      context,
      log: mockLog,
    });
    expect(provider).toBeDefined();
  });

  it("updates persistent cache when models are deleted from a server", async () => {
    const context = mockContext();
    const provider = new OmniRouteChatProvider({
      context,
      log: mockLog,
    });

    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "route-1", name: "Server 1", baseUrl: "http://localhost:8080" },
    ]);

    const mockClient = {
      listModels: vi.fn().mockResolvedValue([]),
    };
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(mockClient as unknown as ReturnType<typeof routesModule.getClientForRoute>);

    await provider.refresh();
    const infos = await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    expect(infos).toEqual([]);
    expect(context.globalState.get("omnicopilot-dev.cachedCatalog.v1")).toEqual([]);
  });

  it("persists removal of a configured route even while the cache is fresh", async () => {
    const context = mockContext();
    await context.globalState.update("omnicopilot-dev.cachedCatalog.v1", [
      { entry: { routeId: "A", routeName: "A", modelId: "model-a", prefixedId: "A · model-a" }, model: { id: "model-a" } },
      { entry: { routeId: "B", routeName: "B", modelId: "model-b", prefixedId: "B · model-b" }, model: { id: "model-b" } },
    ]);
    await context.globalState.update("omnicopilot-dev.cachedCatalogTime.v1", Date.now());
    OmniRouteChatProvider.loadPersistentCache(context);
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "A", baseUrl: "http://a/v1" },
    ]);

    const provider = new OmniRouteChatProvider({ context, log: mockLog });
    const infos = await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);

    expect(infos.map((info) => info.omniModelId)).toEqual(["model-a"]);
    await vi.waitFor(() => expect(context.globalState.get("omnicopilot-dev.cachedCatalog.v1")).toEqual([
      expect.objectContaining({ entry: expect.objectContaining({ routeId: "A" }) }),
    ]));
  });

  it("does not let an older discovery overwrite a manual refresh", async () => {
    const context = mockContext();
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "A", baseUrl: "http://a/v1" },
    ]);
    let resolveOld!: (models: Array<{ id: string }>) => void;
    const oldModels = new Promise<Array<{ id: string }>>((resolve) => { resolveOld = resolve; });
    const listModels = vi.fn()
      .mockReturnValueOnce(oldModels)
      .mockResolvedValueOnce([{ id: "model-new" }]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue({ listModels } as never);
    const provider = new OmniRouteChatProvider({ context, log: mockLog });

    await provider.refresh();
    const oldDiscovery = provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    await vi.waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));
    await provider.refresh();
    const refreshed = await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    resolveOld([{ id: "model-old" }]);
    await oldDiscovery;

    expect(refreshed.map((info) => info.omniModelId)).toEqual(["model-new"]);
    expect(provider.cachedModels.map((item) => item.model.id)).toEqual(["model-new"]);
  });

  it("prunes models belonging to deleted routes", async () => {
    const context = mockContext();
    const provider = new OmniRouteChatProvider({
      context,
      log: mockLog,
    });

    // Populate cache with a route that will be deleted
    await context.globalState.update("omnicopilot-dev.cachedCatalog.v1", [
      {
        entry: { routeId: "deleted-route", routeName: "Old Server", modelId: "gpt-4", prefixedId: "Old Server · gpt-4" },
        model: { id: "gpt-4", owned_by: "openai", display_name: "GPT-4" },
      },
    ]);
    await context.globalState.update("omnicopilot-dev.cachedCatalogTime.v1", Date.now());
    OmniRouteChatProvider.loadPersistentCache(context);

    // Active routes no longer include "deleted-route"
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "active-route", name: "Active Server", baseUrl: "http://localhost:8080" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue({
      listModels: vi.fn().mockResolvedValue([]),
    } as unknown as ReturnType<typeof routesModule.getClientForRoute>);

    const infos = await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    expect(infos.some((i) => i.routeId === "deleted-route")).toBe(false);
  });

  it("persists reasoning/thinking capabilities in the slim cache", async () => {
    const context = mockContext();
    const provider = new OmniRouteChatProvider({
      context,
      log: mockLog,
    });

    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "route-1", name: "Server 1", baseUrl: "http://localhost:8080" },
    ]);
    const mockClient = {
      listModels: vi.fn().mockResolvedValue([
        {
          id: "o3-mini",
          owned_by: "openai",
          display_name: "o3-mini",
          supported_endpoints: ["responses"],
          capabilities: { reasoning: true, thinking: true, tool_calling: true },
        },
      ]),
    };
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(mockClient as unknown as ReturnType<typeof routesModule.getClientForRoute>);

    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);

    // persistCache is fire-and-forget; wait until it lands in globalState.
    await vi.waitFor(() => {
      const saved = context.globalState.get("omnicopilot-dev.cachedCatalog.v1") as unknown as Array<{
        model: { capabilities: Record<string, unknown>; supported_endpoints: string[] };
      }>;
      expect(saved).toHaveLength(1);
      expect(saved[0].model.capabilities.reasoning).toBe(true);
      expect(saved[0].model.capabilities.thinking).toBe(true);
      expect(saved[0].model.supported_endpoints).toEqual(["responses"]);
    });

    // A reload served from this persisted cache keeps supportsReasoning.
    const provider2 = new OmniRouteChatProvider({ context, log: mockLog });
    await context.globalState.update("omnicopilot-dev.cachedCatalogTime.v1", Date.now());
    OmniRouteChatProvider.loadPersistentCache(context);
    const infos = await provider2.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    expect(infos).toHaveLength(1);
    expect(infos[0].supportsReasoning).toBe(true);
  });

  it("uses OmniRoute max_output_tokens and forwards the selected output limit", async () => {
    const context = mockContext();
    const provider = new OmniRouteChatProvider({ context, log: mockLog });
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "route-limit", name: "Limit Server", baseUrl: "http://limit.test/v1" },
    ]);
    const streamModel = vi.fn().mockImplementation(async function* () {
      yield { kind: "text", text: "ok" };
    });
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue({
      baseUrl: "http://limit.test/v1",
      listModels: vi.fn().mockResolvedValue([{
        id: "openai/limited",
        max_output_tokens: 8192,
        max_completion_tokens: 4096,
      }]),
      streamModel,
    } as unknown as ReturnType<typeof routesModule.getClientForRoute>);

    await provider.refresh();
    const infos = await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);

    expect(infos).toHaveLength(1);
    expect(infos[0].maxOutputTokens).toBe(8192);
    await provider.provideLanguageModelChatResponse(
      infos[0],
      [{ role: 1, content: "hi" }] as never,
      {} as never,
      { report: vi.fn() } as never,
      dummyToken
    );
    expect(streamModel.mock.calls[0][0]).toMatchObject({ max_tokens: 8192 });
    await vi.waitFor(() => {
      const saved = context.globalState.get("omnicopilot-dev.cachedCatalog.v1") as Array<{
        model: { max_output_tokens?: number };
      }>;
      expect(saved[0].model.max_output_tokens).toBe(8192);
    });
  });

  it("keeps last-known models when a route's discovery fails transiently", async () => {
    const context = mockContext();
    const provider = new OmniRouteChatProvider({
      context,
      log: mockLog,
    });

    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "route-1", name: "Server 1", baseUrl: "http://localhost:8080" },
    ]);
    const mockClient = {
      // First refresh succeeds (56 models), second call fails (slow/timeout).
      listModels: vi
        .fn()
        .mockResolvedValueOnce([
          { id: "openai/gpt-4o", owned_by: "openai", display_name: "GPT-4o" },
        ])
        .mockRejectedValueOnce(new Error("Timeout listing models after 60000ms")),
    };
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(mockClient as unknown as ReturnType<typeof routesModule.getClientForRoute>);

    await provider.refresh();
    // First discovery populates the catalog.
    const first = await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    expect(first).toHaveLength(1);
    expect(first[0].omniModelId).toBe("openai/gpt-4o");

    // Force the in-memory catalog stale so the second call re-runs discovery
    // instead of serving the fresh cache (which would never hit the failure).
    (OmniRouteChatProvider as unknown as { sharedLastCatalogFetch: number }).sharedLastCatalogFetch = 0;

    // Second discovery fails; the previously discovered model must survive.
    const second = await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    expect(second).toHaveLength(1);
    expect(second[0].omniModelId).toBe("openai/gpt-4o");
    // The provider still reports a complete catalog (no transient wipe).
    expect(context.globalState.get("omnicopilot-dev.cachedCatalog.v1")).not.toEqual([]);
  });

  it("reconstructs sharedRouteCatalogs on loadPersistentCache so models survive startup discovery failure", async () => {
    const context = mockContext();
    // Simulate persistent cache on disk from a previous session
    await context.globalState.update("omnicopilot-dev.cachedCatalog.v1", [
      {
        entry: {
          routeId: "route-ashburn",
          routeName: "Ashburn",
          modelId: "openai/gpt-4o",
          prefixedId: "Ashburn · openai/gpt-4o",
        },
        model: {
          id: "openai/gpt-4o",
          owned_by: "openai",
          display_name: "GPT-4o",
          capabilities: { tool_calling: true },
        },
      },
    ]);
    await context.globalState.update("omnicopilot-dev.cachedCatalogTime.v1", Date.now() - 100_000_000); // stale TTL

    // On startup: load persistent cache
    OmniRouteChatProvider.loadPersistentCache(context);

    const provider = new OmniRouteChatProvider({
      context,
      log: mockLog,
    });

    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "route-ashburn", name: "Ashburn", baseUrl: "http://10.0.0.143:20128/v1" },
    ]);
    // The very first discovery run on startup fails (timeout/slow)
    const mockClient = {
      listModels: vi.fn().mockRejectedValue(new Error("Timeout listing models after 60000ms")),
    };
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(mockClient as unknown as ReturnType<typeof routesModule.getClientForRoute>);

    const infos = await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    // Models from Ashburn must survive!
    expect(infos).toHaveLength(1);
    expect(infos[0].omniModelId).toBe("openai/gpt-4o");
    // The picker shows the model's catalog id plus the server name —
    // `openai/gpt-4o (Ashburn)` — matching the import list in OmniRoute.
    expect(infos[0].name).toBe("openai/gpt-4o (Ashburn)");
    expect(infos[0].tooltip).toContain("Ashburn");
  });

  it("returns no models when discovery fails and there is nothing cached", async () => {
    const context = mockContext();
    const provider = new OmniRouteChatProvider({
      context,
      log: mockLog,
    });

    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "route-1", name: "Server 1", baseUrl: "http://localhost:8080" },
    ]);
    const mockClient = {
      listModels: vi.fn().mockRejectedValue(new Error("connection refused")),
    };
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(mockClient as unknown as ReturnType<typeof routesModule.getClientForRoute>);

    await provider.refresh();
    const infos = await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    expect(infos).toEqual([]);
    // Nothing was invented out of thin air.
    expect(context.globalState.get("omnicopilot-dev.cachedCatalog.v1")).toEqual([]);
  });

  it("forwards reported usage and cached tokens to onUsage callback", async () => {
    const context = mockContext();
    const onUsage = vi.fn();
    const provider = new OmniRouteChatProvider({
      context,
      log: mockLog,
      onUsage,
    });

    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "route-1", name: "Server 1", baseUrl: "http://localhost:8080/v1" },
    ]);

    const mockClient = {
      baseUrl: "http://localhost:8080/v1",
      streamModel: vi.fn().mockImplementation(async function* () {
        yield { kind: "text", text: "Hello world answer" };
        yield {
          kind: "usage",
          usage: {
            inputTokens: 110,
            outputTokens: 40,
            cachedTokens: 75,
            reasoningTokens: 12,
            totalTokens: 150,
          },
        };
      }),
    };
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(mockClient as unknown as ReturnType<typeof routesModule.getClientForRoute>);

    const progress = { report: vi.fn() };
    const model = {
      id: "Server 1 · openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "route-1",
      name: "GPT-4o",
      family: "openai",
      version: "1.0.0",
      maxInputTokens: 10000,
      maxOutputTokens: 4096,
      capabilities: {},
    };

    await provider.provideLanguageModelChatResponse(
      model as never,
      [{ role: 1, content: "hi" }] as never,
      {} as never,
      progress as never,
      dummyToken
    );

    expect(onUsage).toHaveBeenCalledWith({
      routeId: "route-1",
      baseUrl: "http://localhost:8080/v1",
      serverName: "Server 1",
      modelName: "openai/gpt-4o",
      inputTokens: 110,
      outputTokens: 40,
      cachedTokens: 75,
      reasoningTokens: 12,
      inputTokenProvenance: "reported",
      outputTokenProvenance: "reported",
    });
  });


  it("derives mixed provenance and clamps reasoning to estimated output", async () => {
    const context = mockContext();
    const onUsage = vi.fn();
    const provider = new OmniRouteChatProvider({ context, log: mockLog, onUsage });
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "route-1", name: "Server 1", baseUrl: "http://localhost:8080/v1" },
    ]);
    const mockClient = {
      baseUrl: "http://localhost:8080/v1",
      streamModel: vi.fn().mockImplementation(async function* () {
        yield { kind: "text", text: "estimated output" };
        yield { kind: "usage", usage: { inputTokens: 110, cachedTokens: 75, reasoningTokens: 12 } };
      }),
    };
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      mockClient as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );
    await provider.provideLanguageModelChatResponse(
      {
        id: "Server 1 · openai/gpt-4o",
        omniModelId: "openai/gpt-4o",
        routeId: "route-1",
        name: "GPT-4o",
        family: "openai",
        version: "1.0.0",
        maxInputTokens: 10000,
        maxOutputTokens: 4096,
        capabilities: {},
      } as never,
      [{ role: 1, content: "hi" }] as never,
      {} as never,
      { report: vi.fn() } as never,
      dummyToken
    );

    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({
      inputTokenProvenance: "reported",
      outputTokenProvenance: "estimated",
      outputTokens: 4,
      reasoningTokens: 4,
    }));
  });

  it("falls back from invalid reported counts and marks the affected sides estimated", async () => {
    const onUsage = vi.fn();
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog, onUsage });
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "route-1", name: "Server 1", baseUrl: "http://localhost:8080/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue({
      baseUrl: "http://localhost:8080/v1",
      streamModel: vi.fn().mockImplementation(async function* () {
        yield { kind: "text", text: "abcd" };
        yield {
          kind: "usage",
          usage: {
            inputTokens: Number.NaN,
            outputTokens: Number.POSITIVE_INFINITY,
            cachedTokens: -1,
            reasoningTokens: Number.NaN,
          },
        };
      }),
    } as unknown as ReturnType<typeof routesModule.getClientForRoute>);

    await provider.provideLanguageModelChatResponse(
      {
        id: "Server 1 · openai/gpt-4o",
        omniModelId: "openai/gpt-4o",
        routeId: "route-1",
      } as never,
      [{ role: 1, content: "hi" }] as never,
      {} as never,
      { report: vi.fn() } as never,
      dummyToken
    );

    const usage = onUsage.mock.calls[0][0];
    expect(usage).toMatchObject({
      inputTokenProvenance: "estimated",
      outputTokenProvenance: "estimated",
    });
    expect(Number.isFinite(usage.inputTokens)).toBe(true);
    expect(Number.isFinite(usage.outputTokens)).toBe(true);
    expect(usage.inputTokens).toBeGreaterThanOrEqual(0);
    expect(usage.outputTokens).toBeGreaterThanOrEqual(0);
    expect(usage).not.toHaveProperty("cachedTokens");
    expect(usage).not.toHaveProperty("reasoningTokens");
  });

  it("preserves explicit zero subsets while omitting absent subsets", async () => {
    const onUsage = vi.fn();
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog, onUsage });
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "route-1", name: "Server 1", baseUrl: "http://localhost:8080/v1" },
    ]);
    const streamModel = vi.fn()
      .mockImplementationOnce(async function* () {
        yield { kind: "usage", usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 0, reasoningTokens: 0 } };
      })
      .mockImplementationOnce(async function* () {
        yield { kind: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
      });
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue({
      baseUrl: "http://localhost:8080/v1",
      streamModel,
    } as unknown as ReturnType<typeof routesModule.getClientForRoute>);
    const model = {
      id: "Server 1 · openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "route-1",
    } as never;

    await provider.provideLanguageModelChatResponse(
      model, [], {} as never, { report: vi.fn() } as never, dummyToken
    );
    await provider.provideLanguageModelChatResponse(
      model, [], {} as never, { report: vi.fn() } as never, dummyToken
    );

    expect(onUsage.mock.calls[0][0]).toMatchObject({ cachedTokens: 0, reasoningTokens: 0 });
    expect(Object.hasOwn(onUsage.mock.calls[0][0], "cachedTokens")).toBe(true);
    expect(Object.hasOwn(onUsage.mock.calls[0][0], "reasoningTokens")).toBe(true);
    expect(onUsage.mock.calls[1][0]).not.toHaveProperty("cachedTokens");
    expect(onUsage.mock.calls[1][0]).not.toHaveProperty("reasoningTokens");
  });

  it("accepts CancellationToken directly as first argument (VS Code API signature)", async () => {
    const context = mockContext();
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "route-1", name: "Server 1", baseUrl: "http://localhost:8080/v1" },
    ]);
    const mockClient = {
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
    };
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(mockClient as unknown as ReturnType<typeof routesModule.getClientForRoute>);

    const provider = new OmniRouteChatProvider({ context, log: mockLog });
    await provider.refresh();
    const infos = await provider.provideLanguageModelChatInformation(dummyToken);
    expect(infos).toHaveLength(1);
    expect(infos?.[0]?.name).toContain("openai/gpt-4o");
    expect(mockClient.listModels).toHaveBeenCalledWith(dummyToken);
  });

  it("canonicalModelFamily identifies known families and falls back", () => {
    expect(canonicalModelFamily("claude-3-7-sonnet")).toBe("claude");
    expect(canonicalModelFamily("anthropic/claude-3-5-sonnet")).toBe("claude");
    expect(canonicalModelFamily("gpt-4o-mini")).toBe("gpt-4o");
    expect(canonicalModelFamily("openai/gpt-4o")).toBe("gpt-4o");
    expect(canonicalModelFamily("deepseek-ai/deepseek-r1")).toBe("deepseek");
    expect(canonicalModelFamily("gemini-2.0-flash")).toBe("gemini");
    expect(canonicalModelFamily("qwen/qwen-2.5-coder")).toBe("qwen");
    expect(canonicalModelFamily("o1-mini")).toBe("o1");
    expect(canonicalModelFamily("o3-mini")).toBe("o3");
    expect(canonicalModelFamily("meta-llama/llama-3.3-70b")).toBe("llama");
    expect(canonicalModelFamily("unknown-model", "acme")).toBeUndefined();
    expect(canonicalModelFamily("unknown-model", "custom")).toBeUndefined();
    expect(displayModelFamily("unknown-model", "acme")).toBe("acme");
    expect(displayModelFamily("unknown-model", "custom")).toBe("unknown-model");
  });

  it("streams thinking event and reports formatted thinking in progress", async () => {
    const context = mockContext();
    const provider = new OmniRouteChatProvider({ context, log: mockLog });
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "route-1", name: "Server 1", baseUrl: "http://localhost:8080/v1" },
    ]);
    const mockClient = {
      baseUrl: "http://localhost:8080/v1",
      streamModel: vi.fn().mockImplementation(async function* () {
        yield { kind: "thinking", text: "I need to calculate 2 + 2." };
        yield { kind: "text", text: "4" };
      }),
    };
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      mockClient as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );
    const reportedParts: vscode.LanguageModelResponsePart[] = [];
    const progress = {
      report: (p: vscode.LanguageModelResponsePart) => reportedParts.push(p),
    };

    await provider.provideLanguageModelChatResponse(
      {
        id: "Server 1 · openai/o3-mini",
        omniModelId: "openai/o3-mini",
        routeId: "route-1",
        name: "o3-mini",
        family: "o3",
        version: "1.0.0",
        maxInputTokens: 10000,
        maxOutputTokens: 4096,
        capabilities: {},
      } as never,
      [{ role: 1, content: "2+2" }] as never,
      {} as never,
      progress as never,
      dummyToken
    );

    expect(reportedParts.length).toBeGreaterThan(1);
    const textValues = reportedParts
      .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
      .map((p) => p.value);
    expect(textValues.some((v) => v.includes("Thinking"))).toBe(true);
    expect(textValues.some((v) => v.includes("I need to calculate"))).toBe(true);
    expect(textValues.some((v) => v.includes("4"))).toBe(true);
  });

  it("loop guard blocks first runaway loop but allows explicit retry on the same model", async () => {
    const context = mockContext();
    const provider = new OmniRouteChatProvider({ context, log: mockLog });
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "route-1", name: "Server 1", baseUrl: "http://localhost:8080/v1" },
    ]);
    const mockClient = {
      baseUrl: "http://localhost:8080/v1",
      streamModel: vi.fn().mockReturnValue([{ kind: "text", text: "recovered output" }]),
    };
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      mockClient as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );

    const callPart = new vscode.LanguageModelToolCallPart("c1", "replace_string_in_file", { file: "a.ts" });
    const resultPart = new vscode.LanguageModelToolResultPart("c1", [new vscode.LanguageModelTextPart("failed")]);

    // Build history with 5 consecutive identical tool calls
    const loopingMessages: Parameters<typeof provider.provideLanguageModelChatResponse>[1] = [
      { role: 1, content: [new vscode.LanguageModelTextPart("start")] } as never,
      { role: 2, content: [callPart] } as never,
      { role: 1, content: [resultPart] } as never,
      { role: 2, content: [callPart] } as never,
      { role: 1, content: [resultPart] } as never,
      { role: 2, content: [callPart] } as never,
      { role: 1, content: [resultPart] } as never,
      { role: 2, content: [callPart] } as never,
      { role: 1, content: [resultPart] } as never,
      { role: 2, content: [callPart] } as never,
      { role: 1, content: [resultPart] } as never,
    ];

    const modelInfo = {
      id: "Server 1 · openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "route-1",
      name: "gpt-4o",
      family: "gpt-4o",
      version: "1.0.0",
      maxInputTokens: 10000,
      maxOutputTokens: 4096,
      capabilities: {},
    } as never;

    // First attempt: loop guard detects 5 identical calls and blocks with OmniRouteError
    await expect(
      provider.provideLanguageModelChatResponse(
        modelInfo,
        loopingMessages,
        {} as never,
        { report: vi.fn() } as never,
        dummyToken
      )
    ).rejects.toThrow(/consecutive identical calls to tool "replace_string_in_file"/);

    // Second attempt (user clicks Try Again on the same model): loop guard bypasses block and executes
    const reported: vscode.LanguageModelResponsePart[] = [];
    await provider.provideLanguageModelChatResponse(
      modelInfo,
      loopingMessages,
      {} as never,
      { report: (p: vscode.LanguageModelResponsePart) => reported.push(p) } as never,
      dummyToken
    );

    expect(reported.length).toBeGreaterThan(0);
    expect(mockClient.streamModel).toHaveBeenCalledTimes(1);
  });

  it("loop guard state in one conversation does not block an unrelated conversation", async () => {
    const context = mockContext();
    const provider = new OmniRouteChatProvider({ context, log: mockLog });
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "route-1", name: "Server 1", baseUrl: "http://localhost:8080/v1" },
    ]);
    const mockClient = {
      baseUrl: "http://localhost:8080/v1",
      streamModel: vi.fn().mockReturnValue([{ kind: "text", text: "normal output" }]),
    };
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      mockClient as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );

    const callPart = new vscode.LanguageModelToolCallPart("c1", "replace_string_in_file", { file: "a.ts" });
    const resultPart = new vscode.LanguageModelToolResultPart("c1", [new vscode.LanguageModelTextPart("failed")]);

    const loopingMessages: Parameters<typeof provider.provideLanguageModelChatResponse>[1] = [
      { role: 1, content: [new vscode.LanguageModelTextPart("conversation-A-task")] } as never,
      { role: 2, content: [callPart] } as never,
      { role: 1, content: [resultPart] } as never,
      { role: 2, content: [callPart] } as never,
      { role: 1, content: [resultPart] } as never,
      { role: 2, content: [callPart] } as never,
      { role: 1, content: [resultPart] } as never,
      { role: 2, content: [callPart] } as never,
      { role: 1, content: [resultPart] } as never,
      { role: 2, content: [callPart] } as never,
      { role: 1, content: [resultPart] } as never,
    ];

    const cleanMessages: Parameters<typeof provider.provideLanguageModelChatResponse>[1] = [
      { role: 1, content: [new vscode.LanguageModelTextPart("conversation-B-math-question")] } as never,
    ];

    const modelInfo = {
      id: "Server 1 · openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "route-1",
      name: "gpt-4o",
      family: "gpt-4o",
      version: "1.0.0",
      maxInputTokens: 10000,
      maxOutputTokens: 4096,
      capabilities: {},
    } as never;

    // Conversation A triggers loop guard and is blocked
    await expect(
      provider.provideLanguageModelChatResponse(
        modelInfo,
        loopingMessages,
        {} as never,
        { report: vi.fn() } as never,
        dummyToken
      )
    ).rejects.toThrow(/consecutive identical calls/);

    // Conversation B (running concurrently or next on the same model) must NOT be blocked
    const reportedB: vscode.LanguageModelResponsePart[] = [];
    await provider.provideLanguageModelChatResponse(
      modelInfo,
      cleanMessages,
      {} as never,
      { report: (p: vscode.LanguageModelResponsePart) => reportedB.push(p) } as never,
      dummyToken
    );

    expect(reportedB.length).toBeGreaterThan(0);
    expect(mockClient.streamModel).toHaveBeenCalledTimes(1);
  });
});
