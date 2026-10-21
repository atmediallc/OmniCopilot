import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { OmniRouteChatProvider } from "../src/provider";
import { OmniRouteError } from "../src/client";
import * as routesModule from "../src/routes";
import { configValues } from "./vscode.mock";

/** Request-level retry and fail-closed routing coverage. Legacy fallbackMode
 * settings never authorize cross-server or cross-model dispatch. */

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

describe("fail-closed routing at the request level", () => {
  afterEach(() => {
    routesModule.resetAllCooldowns();
    delete configValues["omnicopilot-dev"];
    vi.restoreAllMocks();
  });

  it("performs the initial request when retriesPerServer is zero", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 0, fallbackMode: "sameModel" };
    const onRequestEnd = vi.fn();
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog, onRequestEnd });
    const client = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockReturnValue([{ kind: "text", text: "initial attempt answered" }]),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      client as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    const model = {
      id: "openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];
    const progress = { report: vi.fn() };

    await provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      progress as unknown as vscode.Progress<unknown>,
      dummyToken
    );

    expect(client.streamModel).toHaveBeenCalledTimes(1);
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "initial attempt answered" })
    );
    expect(onRequestEnd).toHaveBeenCalledWith(true, undefined, 0);
  });

  it("treats retriesPerServer as retries after the initial attempt", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 2, fallbackMode: "sameModel" };
    const onRequestEnd = vi.fn();
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog, onRequestEnd });
    let attempts = 0;
    const client = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        attempts += 1;
        if (attempts <= 2) {
          throw new OmniRouteError(
            "temporarily unavailable",
            503,
            false,
            "headers",
            "/chat/completions",
            undefined,
            0
          );
        }
        yield { kind: "text", text: "third attempt answered" };
      }),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      client as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    const model = {
      id: "openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];
    const progress = { report: vi.fn() };

    await provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      progress as unknown as vscode.Progress<unknown>,
      dummyToken
    );

    expect(client.streamModel).toHaveBeenCalledTimes(3);
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "third attempt answered" })
    );
    expect(onRequestEnd).toHaveBeenCalledWith(true, undefined, 0);
  });

  it("defaults retriesPerServer to one retry after the initial attempt", async () => {
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog });
    let attempts = 0;
    const client = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        attempts += 1;
        if (attempts === 1) {
          throw new OmniRouteError("temporarily unavailable", 503, false, "headers", undefined, undefined, 0);
        }
        yield { kind: "text", text: "default retry answered" };
      }),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      client as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);

    await provider.provideLanguageModelChatResponse(
      { id: "openai/gpt-4o", omniModelId: "openai/gpt-4o", routeId: "A" } as never,
      [],
      {} as never,
      { report: vi.fn() } as never,
      dummyToken
    );

    expect(client.streamModel).toHaveBeenCalledTimes(2);
  });

  it("retries the selected server without dispatching to another server when it fails", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 1, fallbackMode: "full" };

    const context = mockContext();
    const onRequestEnd = vi.fn();
    const provider = new OmniRouteChatProvider({ context, log: mockLog, onRequestEnd });

    // Server A: healthy at model-listing time but its chat endpoint is down.
    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError("fetch failed", undefined);
      }),
    };
    // Server B offers the same model, but discovery does not authorize dispatch.
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi
        .fn()
        .mockResolvedValue([{ id: "openai/gpt-4o" }, { id: "kimi/k2" }]),
      streamModel: vi.fn().mockReturnValue([{ kind: "text", text: "fallback reply" }]),
    };

    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
      { id: "B", name: "Server B", baseUrl: "http://server-b.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation(
      ((route: routesModule.Route) => (route.id === "A" ? clientA : clientB)) as unknown as typeof routesModule.getClientForRoute
    );

    // Seed the catalog (both servers' models) the way the extension does:
    // refresh() only clears shared caches — model discovery runs on the
    // provideLanguageModelChatInformation call.
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);

    const model = {
      id: "openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];

    const progress = { report: vi.fn() };

    await expect(provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      progress as unknown as vscode.Progress<unknown>,
      dummyToken
    )).rejects.toThrow("fetch failed");

    expect(clientA.streamModel).toHaveBeenCalledTimes(2);
    expect(clientB.streamModel).not.toHaveBeenCalled();
    expect(progress.report).not.toHaveBeenCalled();
    expect(onRequestEnd).toHaveBeenCalledWith(false, "fetch failed", 0);
  });

  it("surfaces selected-route HTTP 401 without retrying or using another route's credentials", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 2, fallbackMode: "sameModel" };
    const onRequestEnd = vi.fn();
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog, onRequestEnd });
    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError(
          "OmniRoute request failed (HTTP 401): Invalid API key",
          401,
          false,
          "headers",
          "/chat/completions"
        );
      }),
    };
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockReturnValue([{ kind: "text", text: "route B answered" }]),
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
      id: "openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];
    const progress = { report: vi.fn() };

    await expect(provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      progress as unknown as vscode.Progress<unknown>,
      dummyToken
    )).rejects.toThrow(/Authentication failed.*Server A.*HTTP 401/);

    expect(clientA.streamModel).toHaveBeenCalledTimes(1);
    expect(clientB.streamModel).not.toHaveBeenCalled();
    expect(progress.report).not.toHaveBeenCalled();
    expect(onRequestEnd).toHaveBeenCalledWith(false, expect.stringContaining("HTTP 401"), 0);
  });

  it("surfaces selected-model HTTP 400 without dispatching to another route", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 0, fallbackMode: "full" };
    const onRequestEnd = vi.fn();
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog, onRequestEnd });
    const reject = () =>
      new OmniRouteError(
        'OmniRoute request failed (HTTP 400): Model \'openai/gpt-9\' could not be resolved to a known provider.',
        400,
        false,
        "headers",
        "/chat/completions"
      );
    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-9" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw reject();
      }),
    };
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-9", owned_by: "openai" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw reject();
      }),
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
      id: "openai/gpt-9",
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

    expect(clientA.streamModel).toHaveBeenCalledTimes(1);
    expect(clientB.streamModel).not.toHaveBeenCalled();
    expect(onRequestEnd).toHaveBeenCalledWith(false, expect.stringContaining("could not be resolved"), 0);
  });

  it("still throws immediately when a failure happens mid-stream after output", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 1, fallbackMode: "sameModel" };
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog });
    const client = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        yield { kind: "text", text: "partial answer" };
        throw new OmniRouteError("stream died", undefined, false, "stream", "/chat/completions");
      }),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      client as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    const model = {
      id: "openai/gpt-4o",
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
    ).rejects.toThrow("stream died");
    // No silent fallback after partial output: VS Code already rendered tokens.
    expect(client.streamModel).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch to an offline alternate after selected-route retries fail", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 1, fallbackMode: "sameModel" };

    const context = mockContext();
    const onRequestEnd = vi.fn();
    // Only server A is currently in the online set (e.g. server B failed a transient ping)
    const getOnlineRouteIds = vi.fn().mockReturnValue(new Set(["A"]));
    const provider = new OmniRouteChatProvider({
      context,
      log: mockLog,
      onRequestEnd,
      getOnlineRouteIds,
    });

    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError("fetch failed", undefined);
      }),
    };
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockReturnValue([{ kind: "text", text: "offline server answered" }]),
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
      id: "openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];

    const progress = { report: vi.fn() };

    await expect(provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      progress as unknown as vscode.Progress<unknown>,
      dummyToken
    )).rejects.toThrow("fetch failed");

    expect(clientA.streamModel).toHaveBeenCalledTimes(2);
    expect(clientB.streamModel).not.toHaveBeenCalled();
    expect(progress.report).not.toHaveBeenCalled();
    expect(onRequestEnd).toHaveBeenCalledWith(false, "fetch failed", 0);
  });

  it.each([
    {
      scenario: "generic HTTP 429",
      status: 429,
      message: "Too many requests",
      expectedAttempts: 2,
    },
    {
      scenario: "HTTP 429 with nested chat_admission_busy",
      status: 429,
      message:
        '{"error":{"message":"Chat admission capacity is temporarily unavailable. Retry shortly.","type":"server_error","code":"chat_admission_busy"}}',
      expectedAttempts: 1,
    },
    {
      scenario: "explicit HTTP 503 admission-capacity rejection",
      status: 503,
      message: "Chat admission capacity is temporarily unavailable",
      expectedAttempts: 1,
    },
    {
      scenario: "generic HTTP 503",
      status: 503,
      message: "Service unavailable",
      expectedAttempts: 2,
    },
  ])("handles $scenario with selected-route retry policy and no unauthorized fallback", async ({ status, message, expectedAttempts }) => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 1, fallbackMode: "full" };

    const context = mockContext();
    const onRequestEnd = vi.fn();
    const provider = new OmniRouteChatProvider({
      context,
      log: mockLog,
      onRequestEnd,
    });

    // Server A: admission full for both models.
    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([
        { id: "openai/gpt-4o" },
        { id: "openai/gpt-4o-mini" },
      ]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError(message, status);
      }),
    };
    // Server B: healthy backup
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockReturnValue([{ kind: "text", text: "server B answered" }]),
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
      id: "openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];

    const progress = { report: vi.fn() };

    await expect(provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      progress as unknown as vscode.Progress<unknown>,
      dummyToken
    )).rejects.toThrow(/busy|rate-limited|Service unavailable/);

    // Explicit admission errors stop immediately; generic transient errors retry.
    expect(clientA.streamModel).toHaveBeenCalledTimes(expectedAttempts);
    expect(clientA.streamModel.mock.calls.map(([request]) => request.model))
      .toEqual(Array(expectedAttempts).fill("openai/gpt-4o"));
    expect(clientB.streamModel).not.toHaveBeenCalled();
    expect(progress.report).not.toHaveBeenCalled();
    expect(onRequestEnd).toHaveBeenCalledWith(false, expect.any(String), 0);
    if (expectedAttempts === 1) {
      expect(routesModule.getRouteCooldown("A")).toMatchObject({
        status,
        reason: "Admission capacity unavailable",
      });
    }
  });

  it("propagates explicit admission rejection without retrying or trying same-route fallback models", { timeout: 15_000 }, async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 1, fallbackMode: "full" };
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog });
    const failure = new OmniRouteError(
      "Chat admission capacity is temporarily unavailable",
      503,
      false,
      "headers",
      "/responses",
      10,
      1
    );
    const client = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([
        { id: "openai/gpt-4o" },
        { id: "openai/gpt-4o-mini" },
      ]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw failure;
      }),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      client as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);

    await expect(provider.provideLanguageModelChatResponse(
      {
        id: "openai/gpt-4o",
        omniModelId: "openai/gpt-4o",
        routeId: "A",
      } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0],
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      { report: vi.fn() } as unknown as vscode.Progress<unknown>,
      dummyToken
    )).rejects.toMatchObject({ status: 503, message: expect.stringContaining("busy or rate-limited") });

    expect(client.streamModel).toHaveBeenCalledTimes(1);
    expect(client.streamModel.mock.calls[0][0]).toMatchObject({ model: "openai/gpt-4o" });
  });

  it("stops on selected-route admission failure without trying alternate routes or models", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 0, fallbackMode: "full" };
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog });
    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([
        { id: "openai/gpt-4o" },
        { id: "openai/gpt-4o-mini" },
      ]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError("admission saturated", 503);
      }),
    };
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError("backup unavailable", 500);
      }),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
      { id: "B", name: "Server B", baseUrl: "http://server-b.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation(
      ((route: routesModule.Route) => route.id === "A" ? clientA : clientB) as unknown as typeof routesModule.getClientForRoute
    );
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    const model = {
      id: "openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];

    await expect(provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      { report: vi.fn() } as unknown as vscode.Progress<unknown>,
      dummyToken
    )).rejects.toThrow(/busy|rate-limited/);

    expect(clientA.streamModel).toHaveBeenCalledTimes(1);
    expect(clientA.streamModel.mock.calls[0][0]).toMatchObject({ model: "openai/gpt-4o" });
    expect(clientB.streamModel).not.toHaveBeenCalled();
  });

  it("rethrows an exhausted admission failure without showing extension error UI", { timeout: 15_000 }, async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 1, fallbackMode: "sameModel" };
    const showErrorMessage = vi.spyOn(vscode.window, "showErrorMessage");
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog });
    const failure = new OmniRouteError("Chat admission capacity is temporarily unavailable", 503);
    const client = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw failure;
      }),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      client as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    const model = {
      id: "openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];

    await expect(provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      { report: vi.fn() } as unknown as vscode.Progress<unknown>,
      dummyToken
    )).rejects.toThrow(/busy|rate-limited/);

    expect(client.streamModel).toHaveBeenCalledTimes(1);
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it("starts 12 simultaneous streams before any response is released or completes", async () => {
    configValues["omnicopilot-dev"] = { fallbackMode: "sameModel" };

    const context = mockContext();
    const onRequestEnd = vi.fn();
    const provider = new OmniRouteChatProvider({ context, log: mockLog, onRequestEnd });
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let signalAllEntered!: () => void;
    const allEntered = new Promise<void>((resolve) => {
      signalAllEntered = resolve;
    });
    let entered = 0;
    const client = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        entered += 1;
        if (entered === 12) signalAllEntered();
        await streamGate;
        yield { kind: "text", text: "done" };
      }),
    };

    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      client as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );

    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);

    const model = {
      id: "openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];
    let completed = 0;
    const responses = Array.from({ length: 12 }, () =>
      provider.provideLanguageModelChatResponse(
        model,
        [],
        {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
        { report: vi.fn() } as unknown as vscode.Progress<unknown>,
        dummyToken
      ).then(() => {
        completed += 1;
      })
    );

    await allEntered;
    expect(client.streamModel).toHaveBeenCalledTimes(12);
    expect(entered).toBe(12);
    expect(completed).toBe(0);

    releaseStream();
    await Promise.all(responses);
    expect(completed).toBe(12);
    expect(onRequestEnd).toHaveBeenCalledTimes(12);
    expect(onRequestEnd).toHaveBeenCalledWith(true, undefined, 0);
  });

  it("does not choose healthy or cooling alternates after selected-route failure", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 1, fallbackMode: "full" };

    const context = mockContext();
    const onRequestEnd = vi.fn();
    const provider = new OmniRouteChatProvider({ context, log: mockLog, onRequestEnd });

    // Mark server B in cooldown
    routesModule.markRouteCooldown("B", 30_000, 429, "Throttled");

    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError("Server A failed", undefined);
      }),
    };
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockReturnValue([{ kind: "text", text: "from B" }]),
    };
    const clientC = {
      baseUrl: "http://server-c.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockReturnValue([{ kind: "text", text: "from C" }]),
    };

    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
      { id: "B", name: "Server B", baseUrl: "http://server-b.local/v1" },
      { id: "C", name: "Server C", baseUrl: "http://server-c.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation(
      ((route: routesModule.Route) => {
        if (route.id === "A") return clientA;
        if (route.id === "B") return clientB;
        return clientC;
      }) as unknown as typeof routesModule.getClientForRoute
    );

    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);

    const model = {
      id: "openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];

    const progress = { report: vi.fn() };

    await expect(provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      progress as unknown as vscode.Progress<unknown>,
      dummyToken
    )).rejects.toThrow("Server A failed");

    expect(clientA.streamModel).toHaveBeenCalledTimes(2);
    expect(clientC.streamModel).not.toHaveBeenCalled();
    expect(clientB.streamModel).not.toHaveBeenCalled();
    expect(progress.report).not.toHaveBeenCalled();
  });

  it("keeps the selected route despite cooldown and another route's healthy status", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 1, fallbackMode: "sameModel" };
    routesModule.markRouteCooldown("A", 30_000, 429, "Throttled");
    const provider = new OmniRouteChatProvider({
      context: mockContext(),
      log: mockLog,
      getOnlineRouteIds: () => new Set(["B"]),
    });
    const callOrder: string[] = [];
    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(() => {
        callOrder.push("A");
        return [{ kind: "text", text: "cooling primary answered" }];
      }),
    };
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(() => {
        callOrder.push("B");
        return [{ kind: "text", text: "healthy fallback answered" }];
      }),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
      { id: "B", name: "Server B", baseUrl: "http://server-b.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation(
      ((route: routesModule.Route) => route.id === "A" ? clientA : clientB) as unknown as typeof routesModule.getClientForRoute
    );
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    const model = {
      id: "openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];
    const progress = { report: vi.fn() };

    await provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      progress as unknown as vscode.Progress<unknown>,
      dummyToken
    );

    expect(callOrder).toEqual(["A"]);
    expect(clientB.streamModel).not.toHaveBeenCalled();
    expect(clientA.streamModel).toHaveBeenCalledTimes(1);
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "cooling primary answered" })
    );
    expect(routesModule.getRouteCooldown("A")).toBeUndefined();
  });

  it("keeps a cooling exact-model route ahead of a healthy lower-quality fallback", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 0, fallbackMode: "full" };
    routesModule.markRouteCooldown("A", 30_000, 429, "Throttled");
    const provider = new OmniRouteChatProvider({
      context: mockContext(),
      log: mockLog,
      getOnlineRouteIds: () => new Set(["B"]),
    });
    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockReturnValue([{ kind: "text", text: "exact model answered" }]),
    };
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "anthropic/claude-haiku" }]),
      streamModel: vi.fn().mockReturnValue([{ kind: "text", text: "lower quality answered" }]),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
      { id: "B", name: "Server B", baseUrl: "http://server-b.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation(
      ((route: routesModule.Route) => route.id === "A" ? clientA : clientB) as unknown as typeof routesModule.getClientForRoute
    );
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    const progress = { report: vi.fn() };

    await provider.provideLanguageModelChatResponse(
      { id: "openai/gpt-4o", omniModelId: "openai/gpt-4o", routeId: "A" } as never,
      [],
      {} as never,
      progress as never,
      dummyToken
    );

    expect(clientA.streamModel).toHaveBeenCalledTimes(1);
    expect(clientA.streamModel.mock.calls[0][0]).toMatchObject({ model: "openai/gpt-4o" });
    expect(clientB.streamModel).not.toHaveBeenCalled();
    expect(progress.report).toHaveBeenCalledWith(expect.objectContaining({ value: "exact model answered" }));
  });

  it("merges repeated partial usage snapshots without additive double-counting", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 1, fallbackMode: "sameModel" };
    const onUsage = vi.fn();
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog, onUsage });
    const client = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        yield { kind: "usage", usage: { inputTokens: 100, cachedTokens: 25 } };
        yield { kind: "usage", usage: { inputTokens: 100, outputTokens: 10 } };
        yield { kind: "usage", usage: { outputTokens: 14 } };
        yield { kind: "text", text: "done" };
      }),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      client as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    const model = {
      id: "openai/gpt-4o",
      omniModelId: "openai/gpt-4o",
      routeId: "A",
    } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];

    await provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      { report: vi.fn() } as unknown as vscode.Progress<unknown>,
      dummyToken
    );

    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({
      routeId: "A",
      baseUrl: "http://server-a.local/v1",
      serverName: "Server A",
      modelName: "openai/gpt-4o",
      inputTokens: 100,
      outputTokens: 14,
      cachedTokens: 25,
      inputTokenProvenance: "reported",
      outputTokenProvenance: "reported",
    });
  });
});

describe("cross-route fallback isolation", () => {
  afterEach(() => {
    routesModule.resetAllCooldowns();
    delete configValues["omnicopilot-dev"];
    vi.restoreAllMocks();
  });

  it("does not bypass a route-scoped picker after the selected model fails", async () => {
    configValues["omnicopilot-dev"] = {
      retriesPerServer: 0,
      fallbackMode: "full",
      crossRouteFallback: false,
    };
    const onRequestEnd = vi.fn();
    // Provider scoped to route A — two models on A, one on B
    const provider = new OmniRouteChatProvider(
      { context: mockContext(), log: mockLog, onRequestEnd },
      "A" // filterRouteId
    );
    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([
        { id: "openai/gpt-4o" },
        { id: "openai/gpt-4o-mini" },
      ]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError("unavailable", 503, false, "headers");
      }),
    };
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockReturnValue([{ kind: "text", text: "server b answered" }]),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
      { id: "B", name: "Server B", baseUrl: "http://server-b.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation(
      ((route: routesModule.Route) => route.id === "A" ? clientA : clientB) as unknown as typeof routesModule.getClientForRoute
    );
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    const progress = { report: vi.fn() };

    await expect(provider.provideLanguageModelChatResponse(
      { id: "openai/gpt-4o", omniModelId: "openai/gpt-4o", routeId: "A" } as never,
      [],
      {} as never,
      progress as never,
      dummyToken
    )).rejects.toThrow(/busy|rate-limited/);

    expect(clientA.streamModel).toHaveBeenCalledTimes(1);
    expect(clientA.streamModel.mock.calls[0][0]).toMatchObject({ model: "openai/gpt-4o" });
    expect(clientB.streamModel).not.toHaveBeenCalled();
    expect(progress.report).not.toHaveBeenCalled();
    expect(onRequestEnd).toHaveBeenCalledWith(false, expect.stringContaining("unavailable"), 0);
  });

  it("does not treat legacy crossRouteFallback=true as permission to change routes", async () => {
    configValues["omnicopilot-dev"] = {
      retriesPerServer: 0,
      fallbackMode: "full",
      crossRouteFallback: true,
    };
    const onRequestEnd = vi.fn();
    const provider = new OmniRouteChatProvider(
      { context: mockContext(), log: mockLog, onRequestEnd },
      "A"
    );
    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError("unavailable", 503, false, "headers");
      }),
    };
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockReturnValue([{ kind: "text", text: "server b answered" }]),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
      { id: "B", name: "Server B", baseUrl: "http://server-b.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation(
      ((route: routesModule.Route) => route.id === "A" ? clientA : clientB) as unknown as typeof routesModule.getClientForRoute
    );
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    const progress = { report: vi.fn() };

    await expect(provider.provideLanguageModelChatResponse(
      { id: "openai/gpt-4o", omniModelId: "openai/gpt-4o", routeId: "A" } as never,
      [],
      {} as never,
      progress as never,
      dummyToken
    )).rejects.toThrow(/busy|rate-limited/);

    expect(clientA.streamModel).toHaveBeenCalledTimes(1);
    expect(clientB.streamModel).not.toHaveBeenCalled();
    expect(progress.report).not.toHaveBeenCalled();
    expect(onRequestEnd).toHaveBeenCalledWith(false, expect.stringContaining("unavailable"), 0);
  });

  it("does not rotate models within a single-route provider", async () => {
    configValues["omnicopilot-dev"] = {
      retriesPerServer: 0,
      fallbackMode: "full",
      crossRouteFallback: false,
    };
    const onRequestEnd = vi.fn();
    const provider = new OmniRouteChatProvider(
      { context: mockContext(), log: mockLog, onRequestEnd },
      "A"
    );
    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([
        { id: "openai/gpt-4o" },
        { id: "anthropic/claude-haiku" },
      ]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError("primary down", 503, false, "headers");
      }),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      clientA as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
    const progress = { report: vi.fn() };

    await expect(provider.provideLanguageModelChatResponse(
      { id: "openai/gpt-4o", omniModelId: "openai/gpt-4o", routeId: "A" } as never,
      [],
      {} as never,
      progress as never,
      dummyToken
    )).rejects.toThrow(/busy|rate-limited/);

    expect(clientA.streamModel).toHaveBeenCalledTimes(1);
    expect(clientA.streamModel.mock.calls[0][0]).toMatchObject({ model: "openai/gpt-4o" });
    expect(progress.report).not.toHaveBeenCalled();
    expect(onRequestEnd).toHaveBeenCalledWith(false, expect.stringContaining("primary down"), 0);
  });

  it("does not run a global retry pass or probe other routes after admission failure", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 0, fallbackMode: "full" };
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog });
    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError("Chat admission capacity is temporarily unavailable", 503);
      }),
    };
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError("Chat admission capacity is temporarily unavailable", 503);
      }),
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

    await expect(provider.provideLanguageModelChatResponse(
      { id: "openai/gpt-4o", omniModelId: "openai/gpt-4o", routeId: "A" } as never,
      [],
      {} as never,
      { report: vi.fn() } as never,
      dummyToken
    )).rejects.toThrow(/busy|rate-limited/);

    expect(clientA.streamModel).toHaveBeenCalledTimes(1);
    expect(clientB.streamModel).not.toHaveBeenCalled();
  });
});