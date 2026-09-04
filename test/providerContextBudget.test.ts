import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { OmniRouteError } from "../src/client";
import { OmniRouteChatProvider } from "../src/provider";
import * as routesModule from "../src/routes";
import { configValues } from "./vscode.mock";

const SETTINGS_KEY = "omnicopilot-dev.modelContextSettings.v1";
const settingKey = (routeId: string, modelId: string) => JSON.stringify([routeId, modelId]);

function mockContext(initial: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(initial));
  const update = vi.fn(async (key: string, value: unknown) => { store.set(key, value); });
  return {
    context: {
      globalState: {
        get: <T,>(key: string, fallback?: T): T | undefined =>
          (store.has(key) ? store.get(key) : fallback) as T | undefined,
        update,
      },
    } as unknown as ConstructorParameters<typeof OmniRouteChatProvider>[0]["context"],
    store,
    update,
  };
}

const mockLog = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
  name: "context-test", logLevel: 0, onDidChangeLogLevel: () => ({ dispose: () => {} }),
  append: () => {}, appendLine: () => {}, clear: () => {}, show: () => {}, hide: () => {}, dispose: () => {},
} as unknown as vscode.LogOutputChannel;

const dummyToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => {} }),
} as unknown as vscode.CancellationToken;

const user = (value: string) => ({
  role: vscode.LanguageModelChatMessageRole.User,
  content: [new vscode.LanguageModelTextPart(value)],
});
const assistant = (value: string) => ({
  role: vscode.LanguageModelChatMessageRole.Assistant,
  content: [new vscode.LanguageModelTextPart(value)],
});

function settings(entries: Array<[string, string, Record<string, unknown>]>) {
  return {
    [SETTINGS_KEY]: Object.fromEntries(entries.map(([routeId, modelId, value]) => [settingKey(routeId, modelId), value])),
  };
}

async function discover(provider: OmniRouteChatProvider) {
  await provider.refresh();
  return provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);
}

describe("candidate-specific max-context enforcement at provider boundary", () => {
  afterEach(() => {
    routesModule.resetAllCooldowns();
    delete configValues["omnicopilot-dev"];
    vi.restoreAllMocks();
  });

  it("applies persisted route+model context policy to the final primary provider request", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 0, fallbackMode: "none", contextSafetyMarginTokens: 32 };
    const { context } = mockContext(settings([
      ["A", "vendor/model", { mode: "manual", maxContextTokens: 180 }],
    ]));
    const streamModel = vi.fn().mockReturnValue([{ kind: "text", text: "ok" }]);
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "A", baseUrl: "http://a.test/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue({
      baseUrl: "http://a.test/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "vendor/model", context_length: 1_000, max_output_tokens: 48 }]),
      streamModel,
    } as never);
    const provider = new OmniRouteChatProvider({ context, log: mockLog });
    const [model] = await discover(provider);
    const oldest = "oldest-" + "x".repeat(400);
    const current = "current-" + "z".repeat(80);

    await provider.provideLanguageModelChatResponse(
      model,
      [user(oldest), assistant("old answer"), user(current)] as never,
      {} as never,
      { report: vi.fn() } as never,
      dummyToken
    );

    expect(streamModel).toHaveBeenCalledTimes(1);
    const request = streamModel.mock.calls[0][0];
    expect(request).toMatchObject({ model: "vendor/model", max_tokens: 48 });
    expect(request.messages.at(-1)).toEqual({ role: "user", content: current });
    expect(request.messages).not.toContainEqual({ role: "user", content: oldest });
  });

  it("uses fallback candidate context and output limits in the exact request passed to its client", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 0, fallbackMode: "sameModel", contextSafetyMarginTokens: 32 };
    const { context } = mockContext();
    const primary = {
      baseUrl: "http://a.test/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "vendor/model", context_length: 4_000, max_output_tokens: 512 }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError("primary unavailable", 500);
      }),
    };
    const fallback = {
      baseUrl: "http://b.test/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "vendor/model", context_length: 600, max_output_tokens: 96 }]),
      streamModel: vi.fn().mockReturnValue([{ kind: "text", text: "fallback" }]),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "A", baseUrl: primary.baseUrl },
      { id: "B", name: "B", baseUrl: fallback.baseUrl },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation(
      ((route: routesModule.Route) => route.id === "A" ? primary : fallback) as never
    );
    const provider = new OmniRouteChatProvider({ context, log: mockLog });
    const [model] = await discover(provider);
    const oldest = "old-" + "o".repeat(1_600);
    const newest = "new-" + "n".repeat(120);

    await provider.provideLanguageModelChatResponse(
      model,
      [user(oldest), assistant("prior"), user(newest)] as never,
      {} as never,
      { report: vi.fn() } as never,
      dummyToken
    );

    expect(fallback.streamModel).toHaveBeenCalledTimes(1);
    const fallbackRequest = fallback.streamModel.mock.calls[0][0];
    expect(fallbackRequest.max_tokens).toBe(96);
    expect(fallbackRequest.messages.at(-1)).toEqual({ role: "user", content: newest });
    expect(fallbackRequest.messages).not.toContainEqual({ role: "user", content: oldest });
  });

  it("skips a fallback whose protected content cannot fit before crossing provider boundary", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 0, fallbackMode: "sameModel", contextSafetyMarginTokens: 32 };
    const { context } = mockContext();
    const clients = {
      A: {
        baseUrl: "http://a.test/v1",
        listModels: vi.fn().mockResolvedValue([{ id: "vendor/model", context_length: 4_000, max_output_tokens: 512 }]),
        streamModel: vi.fn().mockImplementation(async function* () { throw new OmniRouteError("down", 500); }),
      },
      B: {
        baseUrl: "http://b.test/v1",
        listModels: vi.fn().mockResolvedValue([{ id: "vendor/model", context_length: 100, max_output_tokens: 64 }]),
        streamModel: vi.fn(),
      },
      C: {
        baseUrl: "http://c.test/v1",
        listModels: vi.fn().mockResolvedValue([{ id: "vendor/model", context_length: 4_000, max_output_tokens: 128 }]),
        streamModel: vi.fn().mockReturnValue([{ kind: "text", text: "served" }]),
      },
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue(Object.entries(clients).map(([id, client]) => ({
      id, name: id, baseUrl: client.baseUrl,
    })));
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation(
      ((route: routesModule.Route) => clients[route.id as keyof typeof clients]) as never
    );
    const provider = new OmniRouteChatProvider({ context, log: mockLog });
    const [model] = await discover(provider);

    await provider.provideLanguageModelChatResponse(
      model,
      [user("protected-current-" + "x".repeat(800))] as never,
      {} as never,
      { report: vi.fn() } as never,
      dummyToken
    );

    expect(clients.B.streamModel).not.toHaveBeenCalled();
    expect(clients.C.streamModel).toHaveBeenCalledTimes(1);
  });

  it("rebuilds every fallback from immutable original so an earlier reduction cannot contaminate a later larger candidate", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 0, fallbackMode: "sameModel", contextSafetyMarginTokens: 32 };
    const { context } = mockContext();
    const catalogByRoute = {
      A: { context_length: 4_000, max_output_tokens: 256 },
      B: { context_length: 700, max_output_tokens: 96 },
      C: { context_length: 2_000, max_output_tokens: 160 },
    };
    const calls: Record<string, ReturnType<typeof vi.fn>> = {
      A: vi.fn().mockImplementation(async function* () { throw new OmniRouteError("A failed", 500); }),
      B: vi.fn().mockImplementation(async function* () { throw new OmniRouteError("B failed", 500); }),
      C: vi.fn().mockReturnValue([{ kind: "text", text: "C served" }]),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue(Object.keys(calls).map((id) => ({
      id, name: id, baseUrl: `http://${id.toLowerCase()}.test/v1`,
    })));
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation(((route: routesModule.Route) => ({
      baseUrl: route.baseUrl,
      listModels: vi.fn().mockResolvedValue([{ id: "vendor/model", ...catalogByRoute[route.id as keyof typeof catalogByRoute] }]),
      streamModel: calls[route.id],
    })) as never);
    const provider = new OmniRouteChatProvider({ context, log: mockLog });
    const [model] = await discover(provider);
    const originalHistory = [
      user("turn-1-" + "a".repeat(700)),
      assistant("answer-1-" + "b".repeat(500)),
      user("turn-2-" + "c".repeat(500)),
      assistant("answer-2-" + "d".repeat(300)),
      user("current-" + "e".repeat(100)),
    ];

    await provider.provideLanguageModelChatResponse(
      model,
      originalHistory as never,
      {} as never,
      { report: vi.fn() } as never,
      dummyToken
    );

    const middleRequest = calls.B.mock.calls[0][0];
    const finalRequest = calls.C.mock.calls[0][0];
    expect(middleRequest.max_tokens).toBe(96);
    expect(finalRequest.max_tokens).toBe(160);
    expect(middleRequest.messages.length).toBeLessThan(finalRequest.messages.length);
    expect(finalRequest.messages).toContainEqual({ role: "user", content: originalHistory[2].content[0].value });
    expect(finalRequest.messages).toContainEqual({ role: "user", content: originalHistory[0].content[0].value });
    expect(middleRequest.messages).not.toContainEqual({ role: "user", content: originalHistory[0].content[0].value });
    expect(originalHistory).toHaveLength(5);
    expect(originalHistory[0].content[0].value).toMatch(/^turn-1-/);
  });

  it("uses collision-safe route+model keys for equal model ids on different routes", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 0, fallbackMode: "sameModel", contextSafetyMarginTokens: 16 };
    const { context } = mockContext(settings([
      ["A", "same/model", { mode: "manual", maxContextTokens: 900 }],
      ["B", "same/model", { mode: "manual", maxContextTokens: 300 }],
    ]));
    const clients = {
      A: { baseUrl: "http://a.test/v1", streamModel: vi.fn().mockImplementation(async function* () { throw new OmniRouteError("down", 500); }) },
      B: { baseUrl: "http://b.test/v1", streamModel: vi.fn().mockReturnValue([{ kind: "text", text: "ok" }]) },
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue(Object.entries(clients).map(([id, client]) => ({ id, name: id, baseUrl: client.baseUrl })));
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation(((route: routesModule.Route) => ({
      ...clients[route.id as keyof typeof clients],
      listModels: vi.fn().mockResolvedValue([{ id: "same/model", context_length: 2_000, max_output_tokens: 64 }]),
    })) as never);
    const provider = new OmniRouteChatProvider({ context, log: mockLog });
    const [model] = await discover(provider);
    const history = [user("old-" + "x".repeat(1_200)), user("current")];

    await provider.provideLanguageModelChatResponse(model, history as never, {} as never, { report: vi.fn() } as never, dummyToken);

    expect(clients.A.streamModel.mock.calls[0][0].messages.length).toBeGreaterThan(
      clients.B.streamModel.mock.calls[0][0].messages.length
    );
  });
});
