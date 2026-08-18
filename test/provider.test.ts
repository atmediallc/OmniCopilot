import { describe, expect, it, vi } from "vitest";
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

describe("OmniRouteChatProvider", () => {
  it("can be instantiated with dependencies", () => {
    const context = mockContext();
    const provider = new OmniRouteChatProvider({
      context,
      log: { info: () => {}, warn: () => {}, error: () => {} } as any,
    });
    expect(provider).toBeDefined();
  });

  it("updates persistent cache when models are deleted from a server", async () => {
    const context = mockContext();
    const provider = new OmniRouteChatProvider({
      context,
      log: { info: () => {}, warn: () => {}, error: () => {} } as any,
    });

    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "route-1", name: "Server 1", baseUrl: "http://localhost:8080" },
    ]);

    const mockClient = {
      listModels: vi.fn().mockResolvedValue([]),
    };
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(mockClient as any);

    await provider.refresh();
    const infos = await provider.provideLanguageModelChatInformation({ silent: true }, {} as any);
    expect(infos).toEqual([]);
    expect(context.globalState.get("omnicopilot.cachedCatalog.v1")).toEqual([]);
  });

  it("prunes models belonging to deleted routes", async () => {
    const context = mockContext();
    const provider = new OmniRouteChatProvider({
      context,
      log: { info: () => {}, warn: () => {}, error: () => {} } as any,
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

    const infos = await provider.provideLanguageModelChatInformation({ silent: true }, {} as any);
    expect(infos.some((i) => i.routeId === "deleted-route")).toBe(false);
  });
});
