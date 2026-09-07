import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { OmniRouteChatProvider } from "../src/provider";
import * as routesModule from "../src/routes";
import { OmniRouteError } from "../src/client";
import { configValues } from "./vscode.mock";

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  name: "OmniCopilot Protocol Test",
  append: vi.fn(),
  appendLine: vi.fn(),
  clear: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
  replace: vi.fn(),
  logLevel: 2,
  onDidChangeLogLevel: vi.fn(),
} as unknown as vscode.LogOutputChannel;

function mockContext(): vscode.ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get: vi.fn((k: string, def?: unknown) => (store.has(k) ? store.get(k) : def)),
      update: vi.fn(async (k: string, v: unknown) => {
        store.set(k, v);
      }),
      keys: () => Array.from(store.keys()),
      setKeysForSync: vi.fn(),
    },
    secrets: {
      get: vi.fn(async () => undefined),
      store: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
      onDidChange: vi.fn(),
    },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

const dummyToken: vscode.CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
};

describe("Red-Team Protocol, Dynamic Discovery & Cache Invalidation Certification", () => {
  afterEach(() => {
    routesModule.resetAllCooldowns();
    delete configValues["omnicopilot-dev"];
    vi.restoreAllMocks();
  });

  it("DD-01: dynamically discovers unknown new model and makes it usable without family code updates", async () => {
    const context = mockContext();
    const provider = new OmniRouteChatProvider({ context, log: mockLog });
    const dynamicModel = {
      id: "futurevendor/neural-x-2030",
      capabilities: { tool_calling: true, vision: true },
      context_length: 128_000,
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "route-future", name: "Future Server", baseUrl: "http://future.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue({
      baseUrl: "http://future.local/v1",
      listModels: vi.fn().mockResolvedValue([dynamicModel]),
      streamModel: vi.fn().mockReturnValue([{ kind: "text", text: "I am neural-x-2030" }]),
    } as unknown as ReturnType<typeof routesModule.getClientForRoute>);

    await provider.refresh();
    const infos = await provider.provideLanguageModelChatInformation(dummyToken);

    expect(infos).toHaveLength(1);
    expect(infos[0].id).toBe("futurevendor/neural-x-2030");
    expect(infos[0].family).toBe("futurevendor"); // safe display grouping
    expect(infos[0].capabilities.toolCalling).toBe(true);
    expect(infos[0].capabilities.imageInput).toBe(true);

    const progress = { report: vi.fn() };
    await provider.provideLanguageModelChatResponse(
      infos[0],
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      progress as unknown as vscode.Progress<unknown>,
      dummyToken
    );

    expect(progress.report).toHaveBeenCalledWith(expect.objectContaining({ value: "I am neural-x-2030" }));
  });

  it("DD-10: targeted invalidation of stale model when upstream returns 404", async () => {
    const context = mockContext();
    const provider = new OmniRouteChatProvider({ context, log: mockLog });
    const client = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([
        { id: "vendor/model-alpha" },
        { id: "vendor/model-beta" },
      ]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError("Model vendor/model-alpha was deleted upstream", 404, false, "headers", "/chat/completions");
      }),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      client as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );

    await provider.refresh();
    let infos = await provider.provideLanguageModelChatInformation(dummyToken);
    expect(infos).toHaveLength(2);

    const targetModel = infos.find((m) => m.omniModelId === "vendor/model-alpha")!;
    await expect(
      provider.provideLanguageModelChatResponse(
        targetModel,
        [],
        {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
        { report: vi.fn() } as unknown as vscode.Progress<unknown>,
        dummyToken
      )
    ).rejects.toThrow(/not found.*stale/);

    // After 404, pruneModel evicted model-alpha from route A
    infos = await provider.provideLanguageModelChatInformation(dummyToken);
    expect(infos).toHaveLength(1);
    expect(infos[0].omniModelId).toBe("vendor/model-beta");
    expect(infos.some((m) => m.omniModelId === "vendor/model-alpha")).toBe(false);
  });

  it("PC-08: safely removes reasoning_effort when falling back to a non-reasoning candidate", async () => {
    configValues["omnicopilot-dev"] = { retriesPerServer: 0, fallbackMode: "full" };
    const context = mockContext();
    const provider = new OmniRouteChatProvider({ context, log: mockLog });
    let fallbackRequestCaptured: unknown;
    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([
        { id: "openai/o3-mini", capabilities: { reasoning: true } },
      ]),
      streamModel: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError("Server error", 502, false, "headers", "/chat/completions");
      }),
    };
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([
        { id: "meta-llama/llama-3.1-8b", capabilities: { reasoning: false } },
      ]),
      streamModel: vi.fn().mockImplementation(async function* (req) {
        fallbackRequestCaptured = req;
        yield { kind: "text", text: "hello from llama" };
      }),
    };

    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
      { id: "B", name: "Server B", baseUrl: "http://server-b.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation((r: { id: string }) => {
      return (r.id === "A" ? clientA : clientB) as unknown as ReturnType<typeof routesModule.getClientForRoute>;
    });

    await provider.refresh();
    const infos = await provider.provideLanguageModelChatInformation(dummyToken);
    const o3Model = infos.find((m) => m.omniModelId === "openai/o3-mini")!;

    await provider.provideLanguageModelChatResponse(
      o3Model,
      [{ role: 1, content: "think" }] as never,
      { modelOptions: { reasoningEffort: "high" } } as never,
      { report: vi.fn() } as never,
      dummyToken
    );

    // When clientB was called for llama-3.1-8b, reasoning_effort was stripped to avoid 400 rejection
    expect(fallbackRequestCaptured).toBeDefined();
    expect((fallbackRequestCaptured as { reasoning_effort?: string }).reasoning_effort).toBeUndefined();
  });
});
