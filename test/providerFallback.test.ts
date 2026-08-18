import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { OmniRouteChatProvider } from "../src/provider";
import { OmniRouteError } from "../src/client";
import * as routesModule from "../src/routes";
import { configValues } from "./vscode.mock";

/**
 * End-to-end-ish proof that the "full" fallback chain actually runs inside
 * provideLanguageModelChatResponse: two servers, same model on both, primary
 * unreachable → the request is served by the second server and the caller
 * learns 1 fallback was used via onRequestEnd(ok=true, error, fallbacksUsed=1).
 */

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

async function* streamText(text: string): AsyncGenerator<{ kind: string; text: string }> {
  yield { kind: "text", text };
}

describe("full fallback at the request level", () => {
  it("serves the request from a second server when the primary fails", async () => {
    configValues["omnicopilot"] = { retriesPerServer: 1, fallbackMode: "full" };

    const context = mockContext();
    const onRequestEnd = vi.fn();
    const provider = new OmniRouteChatProvider({ context, log: mockLog, onRequestEnd });

    // Server A: healthy at model-listing time but its chat endpoint is down.
    const clientA = {
      baseUrl: "http://server-a.local/v1",
      listModels: vi.fn().mockResolvedValue([{ id: "openai/gpt-4o" }]),
      streamChat: vi.fn().mockImplementation(async function* () {
        throw new OmniRouteError("fetch failed", undefined);
      }),
    };
    // Server B: serves the same model (full fallback tier 1) and extra models.
    const clientB = {
      baseUrl: "http://server-b.local/v1",
      listModels: vi
        .fn()
        .mockResolvedValue([{ id: "openai/gpt-4o" }, { id: "kimi/k2" }]),
      streamChat: vi.fn().mockImplementation(() => streamText("fallback reply")),
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
      id: "Server A · openai/gpt-4o",
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

    // The primary was tried, then the same model on server B answered.
    expect(clientA.streamChat).toHaveBeenCalled();
    expect(clientB.streamChat).toHaveBeenCalled();
    expect(progress.report).toHaveBeenCalledWith(
      expect.objectContaining({ value: "fallback reply" })
    );
    // ok=true, no error, exactly 1 fallback consumed.
    expect(onRequestEnd).toHaveBeenCalledWith(true, undefined, 1);
  });
});