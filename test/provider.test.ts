import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { OmniRouteChatProvider } from "../src/provider";
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

const dummyToken = {} as unknown as vscode.CancellationToken;

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
    expect(context.globalState.get("omnicopilot.cachedCatalog.v1")).toEqual([]);
  });

  it("prunes models belonging to deleted routes", async () => {
    const context = mockContext();
    const provider = new OmniRouteChatProvider({
      context,
      log: mockLog,
    });

    // Populate cache with a route that will be deleted
    await context.globalState.update("omnicopilot.cachedCatalog.v1", [
      {
        entry: { routeId: "deleted-route", routeName: "Old Server", modelId: "gpt-4", prefixedId: "Old Server · gpt-4" },
        model: { id: "gpt-4", owned_by: "openai", display_name: "GPT-4" },
      },
    ]);
    await context.globalState.update("omnicopilot.cachedCatalogTime.v1", Date.now());
    OmniRouteChatProvider.loadPersistentCache(context);

    // Active routes no longer include "deleted-route"
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "active-route", name: "Active Server", baseUrl: "http://localhost:8080" },
    ]);

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
          capabilities: { reasoning: true, thinking: true, tool_calling: true },
        },
      ]),
    };
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(mockClient as unknown as ReturnType<typeof routesModule.getClientForRoute>);

    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);

    // persistCache is fire-and-forget; wait until it lands in globalState.
    await vi.waitFor(() => {
      const saved = context.globalState.get("omnicopilot.cachedCatalog.v1") as unknown as Array<{
        model: { capabilities: Record<string, unknown> };
      }>;
      expect(saved).toHaveLength(1);
      expect(saved[0].model.capabilities.reasoning).toBe(true);
      expect(saved[0].model.capabilities.thinking).toBe(true);
    });

    // A reload served from this persisted cache keeps supportsReasoning.
    const provider2 = new OmniRouteChatProvider({ context, log: mockLog });
    await context.globalState.update("omnicopilot.cachedCatalogTime.v1", Date.now());
    OmniRouteChatProvider.loadPersistentCache(context);
    const infos = await provider2.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    expect(infos).toHaveLength(1);
    expect(infos[0].supportsReasoning).toBe(true);
  });
});
