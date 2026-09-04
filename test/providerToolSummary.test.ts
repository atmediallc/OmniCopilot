import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { OmniRouteError } from "../src/client";
import { OmniRouteChatProvider } from "../src/provider";
import { containsVisibleText } from "../src/visibleText";
import type { StreamEvent } from "../src/types";
import * as routesModule from "../src/routes";
import { configValues } from "./vscode.mock";

type Transport = "responses" | "chatCompletions" | "messages";

const endpointByTransport: Record<Transport, string> = {
  responses: "responses",
  chatCompletions: "chat/completions",
  messages: "POST /v1/messages",
};

function mockContext() {
  const store = new Map<string, unknown>();
  return { globalState: {
    get: <T,>(key: string): T | undefined => store.get(key) as T | undefined,
    update: async (key: string, value: unknown) => { store.set(key, value); },
  } } as unknown as ConstructorParameters<typeof OmniRouteChatProvider>[0]["context"];
}

const mockLog = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
  name: "tool-summary-test", logLevel: 0, onDidChangeLogLevel: () => ({ dispose: () => {} }),
  append: () => {}, appendLine: () => {}, replace: () => {}, clear: () => {}, show: () => {}, hide: () => {}, dispose: () => {},
} as unknown as vscode.LogOutputChannel;

function cancellationToken() {
  const state = { cancelled: false };
  return {
    state,
    token: {
      get isCancellationRequested() { return state.cancelled; },
      onCancellationRequested: () => ({ dispose: () => {} }),
    } as unknown as vscode.CancellationToken,
  };
}

async function prepare(
  transport: Transport,
  stream: (state: { cancelled: boolean }) => AsyncGenerator<StreamEvent>,
) {
  configValues["omnicopilot-dev"] = { retriesPerServer: 1, fallbackMode: "none" };
  const cancellation = cancellationToken();
  const client = {
    baseUrl: "http://a/v1",
    listModels: vi.fn().mockResolvedValue([{
      id: "model-a",
      supported_endpoints: [endpointByTransport[transport]],
    }]),
    streamModel: vi.fn().mockImplementation(() => stream(cancellation.state)),
  };
  vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
    { id: "A", name: "A", baseUrl: "http://a/v1" },
  ]);
  vi.spyOn(routesModule, "getClientForRoute").mockReturnValue(
    client as unknown as ReturnType<typeof routesModule.getClientForRoute>
  );
  const provider = new OmniRouteChatProvider({ context: mockContext(), log: mockLog });
  await provider.refresh();
  await provider.provideLanguageModelChatInformation({ silent: true }, cancellation.token);
  const model = {
    id: "model-a", omniModelId: "model-a", routeId: "A",
  } as unknown as Parameters<typeof provider.provideLanguageModelChatResponse>[0];
  const progress = { report: vi.fn() };
  return { provider, model, client, progress, ...cancellation };
}

function reportedParts(progress: { report: ReturnType<typeof vi.fn> }) {
  return progress.report.mock.calls.map(([part]) => part as vscode.LanguageModelResponsePart);
}

function visibleTexts(progress: { report: ReturnType<typeof vi.fn> }): string[] {
  return reportedParts(progress)
    .filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
    .map((part) => part.value)
    .filter(containsVisibleText);
}

describe("tool-call forwarding", () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each<Transport>(["responses", "chatCompletions", "messages"])(
    "forwards tool-only %s streams without synthetic text",
    async (transport) => {
      const secret = "sk-secret-must-not-leak";
      const { provider, model, client, progress, token } = await prepare(
        transport,
        async function* () {
          yield { kind: "toolCall", id: "call-1", name: "read_file", args: `{"path":"${secret}"}` };
          yield { kind: "toolCall", id: "call-2", name: "search", args: "{\"query\":\"private customer data\"}" };
        },
      );

      await provider.provideLanguageModelChatResponse(model, [], {} as never, progress as never, token);

      expect(client.streamModel.mock.calls[0][2]).toEqual([transport]);
      const calls = reportedParts(progress).filter(
        (part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
      );
      expect(calls.map((part) => ({ id: part.callId, name: part.name, input: part.input }))).toEqual([
        { id: "call-1", name: "read_file", input: { path: secret } },
        { id: "call-2", name: "search", input: { query: "private customer data" } },
      ]);
      expect(reportedParts(progress).filter((part) => part instanceof vscode.LanguageModelTextPart)).toEqual([]);
      expect(progress.report).toHaveBeenCalledTimes(2);
    },
  );

  it("forwards model text and tool calls in stream order without synthetic text", async () => {
    const { provider, model, progress, token } = await prepare(
      "responses",
      async function* () {
        yield { kind: "text", text: "I will inspect the file." };
        yield { kind: "toolCall", id: "call-1", name: "read_file", args: "{}" };
        yield { kind: "text", text: " Inspection requested." };
      },
    );

    await provider.provideLanguageModelChatResponse(model, [], {} as never, progress as never, token);

    const parts = reportedParts(progress);
    expect(parts[0]).toEqual(new vscode.LanguageModelTextPart("I will inspect the file."));
    expect(parts[1]).toEqual(new vscode.LanguageModelToolCallPart("call-1", "read_file", {}));
    expect(parts[2]).toEqual(new vscode.LanguageModelTextPart(" Inspection requested."));
    expect(progress.report).toHaveBeenCalledTimes(3);
  });

  it("treats normal visible Unicode text as visible and does not add a summary", async () => {
    const originalToolName = "buscar_área";
    const visibleUnicode = "你好, мир — café 🚀";
    const { provider, model, progress, token } = await prepare(
      "messages",
      async function* () {
        yield { kind: "text", text: visibleUnicode };
        yield { kind: "toolCall", id: "call-1", name: originalToolName, args: "{}" };
      },
    );

    await provider.provideLanguageModelChatResponse(model, [], {} as never, progress as never, token);

    expect(visibleTexts(progress)).toEqual([visibleUnicode]);
    const calls = reportedParts(progress).filter(
      (part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart
    );
    expect(calls.map((part) => part.name)).toEqual([originalToolName]);
  });


  it("does not add a summary when cancellation occurs after a tool call", async () => {
    const { provider, model, progress, token } = await prepare(
      "chatCompletions",
      async function* (state) {
        yield { kind: "toolCall", id: "call-1", name: "read_file", args: "{}" };
        state.cancelled = true;
      },
    );

    await provider.provideLanguageModelChatResponse(model, [], {} as never, progress as never, token);

    expect(visibleTexts(progress)).toEqual([]);
    expect(reportedParts(progress).filter((part) => part instanceof vscode.LanguageModelToolCallPart)).toHaveLength(1);
  });

  it("does not add a summary when a stream errors after a tool call", async () => {
    const failure = new OmniRouteError("stream failed", 500, false, "stream", "/messages");
    const { provider, model, progress, token } = await prepare(
      "messages",
      async function* () {
        yield { kind: "toolCall", id: "call-1", name: "read_file", args: "{}" };
        throw failure;
      },
    );

    await expect(provider.provideLanguageModelChatResponse(model, [], {} as never, progress as never, token))
      .rejects.toBe(failure);
    expect(visibleTexts(progress)).toEqual([]);
    expect(reportedParts(progress).filter((part) => part instanceof vscode.LanguageModelToolCallPart)).toHaveLength(1);
  });
});