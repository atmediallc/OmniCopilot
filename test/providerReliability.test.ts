import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { OmniRouteChatProvider } from "../src/provider";
import * as routesModule from "../src/routes";
import { OmniRouteError } from "../src/client";

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  name: "OmniCopilot Test",
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

describe("Red-Team Reliability & Failover Certification", () => {
  afterEach(() => {
    routesModule.resetAllCooldowns();
    vi.restoreAllMocks();
  });

  it("CASE E: user cancellation before request starts results in zero upstream attempts", async () => {
    const cancelledToken: vscode.CancellationToken = {
      isCancellationRequested: true,
      onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
    };
    const client = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn(),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      client as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );

    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog });
    const model = { id: "openai/gpt-4o", omniModelId: "openai/gpt-4o", routeId: "A" } as Parameters<typeof provider.provideLanguageModelChatResponse>[0];

    await provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      { report: vi.fn() } as unknown as vscode.Progress<unknown>,
      cancelledToken
    );

    expect(client.streamModel).toHaveBeenCalledTimes(0);
  });

  it("CASE D: mid-stream failure after tool call output throws immediately without fallback", async () => {
    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        yield { kind: "tool", id: "call_123", name: "read_file", args: '{"path":"main.ts"}' };
        throw new OmniRouteError("stream socket hang up", undefined, false, "stream", "/chat/completions");
      }),
    };
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn(),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
      { id: "B", name: "Server B", baseUrl: "http://server-b.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation((route: { id: string }) => {
      return (route.id === "A" ? clientA : clientB) as unknown as ReturnType<typeof routesModule.getClientForRoute>;
    });

    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog });
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);

    const model = { id: "openai/gpt-4o", omniModelId: "openai/gpt-4o", routeId: "A" } as Parameters<typeof provider.provideLanguageModelChatResponse>[0];
    const reportedParts: unknown[] = [];
    const progress = { report: vi.fn((p) => reportedParts.push(p)) };

    await expect(
      provider.provideLanguageModelChatResponse(
        model,
        [],
        {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
        progress as unknown as vscode.Progress<unknown>,
        dummyToken
      )
    ).rejects.toThrow("stream socket hang up");

    // Tool call was rendered to VS Code
    expect(reportedParts.length).toBe(1);
    // Crucial: Server B was NEVER contacted to avoid duplicate/conflicting tool execution
    expect(clientA.streamModel).toHaveBeenCalledTimes(1);
    expect(clientB.streamModel).toHaveBeenCalledTimes(0);
  });

  it("CASE H: cancellation during backoff sleep aborts wait and cancels request immediately", async () => {
    let cancelCallback: (() => void) | undefined;
    const token: vscode.CancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn((cb) => {
        cancelCallback = cb;
        return { dispose: vi.fn() };
      }),
    };

    let attempts = 0;
    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        attempts += 1;
        // Trigger cancellation during sleep after first failure
        setTimeout(() => {
          (token as { isCancellationRequested: boolean }).isCancellationRequested = true;
          cancelCallback?.();
        }, 10);
        throw new OmniRouteError("server overloaded", 503, false, "headers", "/chat/completions");
      }),
    };

    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      clientA as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );

    const onRequestEnd = vi.fn();
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog, onRequestEnd });
    const model = { id: "openai/gpt-4o", omniModelId: "openai/gpt-4o", routeId: "A" } as Parameters<typeof provider.provideLanguageModelChatResponse>[0];

    await provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      { report: vi.fn() } as unknown as vscode.Progress<unknown>,
      token
    );

    // Only 1 attempt ran before cancellation interrupted the backoff wait
    expect(attempts).toBe(1);
    expect(onRequestEnd).toHaveBeenCalledWith(false, undefined, 0);
  });

  it("CASE I: stream stall before first token triggers route cooldown and fails over to secondary route", async () => {
    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* () {
        // Stall: 408 with stall=true, no tokens yielded
        throw new OmniRouteError("OmniRoute went silent for 30s", 408, true, "stream", "/chat/completions");
      }),
    };
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockReturnValue([{ kind: "text", text: "recovered on Server B" }]),
    };

    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
      { id: "B", name: "Server B", baseUrl: "http://server-b.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockImplementation((route: { id: string }) => {
      return (route.id === "A" ? clientA : clientB) as unknown as ReturnType<typeof routesModule.getClientForRoute>;
    });

    const onStall = vi.fn();
    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog, onStall });
    await provider.refresh();
    await provider.provideLanguageModelChatInformation({ silent: true }, dummyToken);

    const model = { id: "openai/gpt-4o", omniModelId: "openai/gpt-4o", routeId: "A" } as Parameters<typeof provider.provideLanguageModelChatResponse>[0];
    const progress = { report: vi.fn() };

    await provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      progress as unknown as vscode.Progress<unknown>,
      dummyToken
    );

    // Client A stalled
    expect(clientA.streamModel).toHaveBeenCalledTimes(1);
    expect(onStall).toHaveBeenCalledWith("A");
    expect(routesModule.isRouteInCooldown("A")).toBe(true);

    // Client B succeeded without duplicate output
    expect(clientB.streamModel).toHaveBeenCalledTimes(1);
    expect(progress.report).toHaveBeenCalledWith(expect.objectContaining({ value: "recovered on Server B" }));
  });

  it("CASE P: concurrent two-request execution isolates cancellation state", async () => {
    let cancelReq1: (() => void) | undefined;
    const tokenReq1: vscode.CancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn((cb) => {
        cancelReq1 = cb;
        return { dispose: vi.fn() };
      }),
    };
    const tokenReq2: vscode.CancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
    };

    const client = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamModel: vi.fn().mockImplementation(async function* (_req, signal) {
        if (signal.aborted) throw new Error("aborted");
        yield { kind: "text", text: "done" };
      }),
    };
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "A", name: "Server A", baseUrl: "http://server-a.local/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
      client as unknown as ReturnType<typeof routesModule.getClientForRoute>
    );

    const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog });
    const model = { id: "openai/gpt-4o", omniModelId: "openai/gpt-4o", routeId: "A" } as Parameters<typeof provider.provideLanguageModelChatResponse>[0];

    // Trigger cancel on req 1 before starting
    (tokenReq1 as { isCancellationRequested: boolean }).isCancellationRequested = true;
    cancelReq1?.();

    const p1 = provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      { report: vi.fn() } as unknown as vscode.Progress<unknown>,
      tokenReq1
    );

    const progress2 = { report: vi.fn() };
    const p2 = provider.provideLanguageModelChatResponse(
      model,
      [],
      {} as Parameters<typeof provider.provideLanguageModelChatResponse>[2],
      progress2 as unknown as vscode.Progress<unknown>,
      tokenReq2
    );

    await Promise.all([p1, p2]);

    // Request 1 aborted before sending
    // Request 2 completed successfully
    expect(progress2.report).toHaveBeenCalledWith(expect.objectContaining({ value: "done" }));
  });
});
