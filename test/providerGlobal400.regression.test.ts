import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { OmniRouteChatProvider } from "../src/provider";
import { OmniRouteError } from "../src/client";
import * as routesModule from "../src/routes";
import { configValues } from "./vscode.mock";

function mockContext() {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get: <T,>(key: string): T | undefined => store.get(key) as T | undefined,
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

describe("P2-01 regression: global 400 must not blind-replay across candidates", () => {
  afterEach(() => {
    routesModule.resetAllCooldowns();
    delete configValues["omnicopilot-dev"];
    vi.restoreAllMocks();
  });

  it("short-circuits candidate loop on global VALID_001 / messages validation 400 (≤1 fetch, not ≤5)", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 0, fallbackMode: "sameModel" };
    const onRequestEnd = vi.fn();
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog, onRequestEnd });

    // Global malformed: messages shape invalid — every route would reject identically.
    // OmniRoute chat route returns 400 "messages: Expected array, received undefined" (chat.ts:413).
    const global400 = new OmniRouteError(
      "OmniRoute request failed (HTTP 400): messages: Expected array, received undefined",
      400,
      false,
      "headers",
      "/chat/completions"
    );

    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () { throw global400; }),
    };
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockReturnValue([{ kind: "text", text: "should never be reached" }]),
    };

    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
      { id: "B", name: "Server B", baseUrl: "http://server-b.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation(
      ((route: routesModule.Route) => (route.id === "A" ? clientA : clientB)) as unknown as typeof routesModule.getClientForRoute
    );

    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    const model = {
      id: "Server A · openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];

    await expect(
      provider.provideLanguageModelChatResponse(
        model,
        [],
        {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
        { report: vi.fn() } as unknown as vscode.Progress<unknown>,
        dummyToken
      )
    ).rejects.toThrow(/messages: Expected array/);

    // Must NOT have tried the second candidate — global validation error short-circuits.
    expect(clientA.streamModel).toHaveBeenCalledTimes(1);
    expect(clientB.streamModel).not.toHaveBeenCalled();
    expect(onRequestEnd).toHaveBeenCalledWith(false, expect.stringContaining("messages: Expected array"), 0);
  });

  it("short-circuits on a structured VALID_* 400 error.code even when the message is opaque", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 0, fallbackMode: "sameModel" };
    const onRequestEnd = vi.fn();
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog, onRequestEnd });

    // OmniRoute v3.8.50 toJsonErrorPayload carries {error:{code:"VALID_001"}}.
    const codedGlobal400 = new OmniRouteError(
      "OmniRoute request failed (HTTP 400): Invalid request body",
      400,
      false,
      "headers",
      "/chat/completions",
      undefined,
      undefined,
      "VALID_001"
    );

    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () { throw codedGlobal400; }),
    };
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockReturnValue([{ kind: "text", text: "should never be reached" }]),
    };

    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
      { id: "B", name: "Server B", baseUrl: "http://server-b.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation(
      ((route: routesModule.Route) => (route.id === "A" ? clientA : clientB)) as unknown as typeof routesModule.getClientForRoute
    );

    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    const model = {
      id: "Server A · openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];

    await expect(
      provider.provideLanguageModelChatResponse(
        model,
        [],
        {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
        { report: vi.fn() } as unknown as vscode.Progress<unknown>,
        dummyToken
      )
    ).rejects.toThrow(/Invalid request body/);

    expect(clientA.streamModel).toHaveBeenCalledTimes(1);
    expect(clientB.streamModel).not.toHaveBeenCalled();
    expect(onRequestEnd).toHaveBeenCalledWith(false, expect.stringContaining("Invalid request body"), 0);
  });

  it("still fails over on route-local 400 model_not_found (existing behavior preserved)", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 0, fallbackMode: "sameModel" };
    const onRequestEnd = vi.fn();
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog, onRequestEnd });

    const local400 = new OmniRouteError(
      "OmniRoute request failed (HTTP 400): Model 'openai/gpt-9' could not be resolved to a known provider.",
      400,
      false,
      "headers",
      "/chat/completions"
    );

    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-9" }]),
      streamModel: vi.fn().mockImplementation(async function* () { throw local400; }),
    };
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-9" }]),
      streamModel: vi.fn().mockImplementation(async function* () { throw local400; }),
    };

    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
      { id: "B", name: "Server B", baseUrl: "http://server-b.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation(
      ((route: routesModule.Route) => (route.id === "A" ? clientA : clientB)) as unknown as typeof routesModule.getClientForRoute
    );

    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    const model = {
      id: "Server A · openai/gpt-9",
      omniModelId: "openai/gpt-9",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];

    await expect(
      provider.provideLanguageModelChatResponse(
        model,
        [],
        {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
        { report: vi.fn() } as unknown as vscode.Progress<unknown>,
        dummyToken
      )
    ).rejects.toThrow(/could not be resolved/);

    // Route-local 400 must still be tried per-candidate (bounded ≤C, not short-circuited).
    expect(clientA.streamModel).toHaveBeenCalledTimes(1);
    expect(clientB.streamModel).toHaveBeenCalledTimes(1);
  });
});
