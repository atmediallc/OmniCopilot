import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { OmniRouteChatProvider } from "../src/provider";
import type { ChatRequest } from "../src/types";
import * as routes from "../src/routes";
import { configValues } from "./vscode.mock";

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as unknown as vscode.LogOutputChannel;

async function setup(toolCalling: boolean | number = true) {
  const store = new Map<string, unknown>();
  const context = {
    globalState: { get: (key: string, fallback?: unknown) => store.get(key) ?? fallback,
      update: async (key: string, value: unknown) => { store.set(key, value); } },
    secrets: { get: async () => undefined },
  } as unknown as vscode.ExtensionContext;
  const requests: ChatRequest[] = [];
  const client = {
    baseUrl: "http://localhost:20128/v1",
    listModels: async () => [{ id: "test/tools", context_length: 128000, capabilities: { tool_calling: toolCalling } }],
    streamModel: async function* (request: ChatRequest) {
      requests.push(request);
      yield { kind: "text", text: "continued" };
    },
  };
  vi.spyOn(routes, "cachedLoadRoutes").mockResolvedValue([{ id: "tools", name: "Tools", baseUrl: client.baseUrl }]);
  vi.spyOn(routes, "getClientForRoute").mockReturnValue(client as unknown as ReturnType<typeof routes.getClientForRoute>);
  const provider = new OmniRouteChatProvider({ context, log });
  await provider.refresh();
  const [model] = await provider.provideLanguageModelChatInformation({ silent: true }, token);
  const send = (tools: vscode.LanguageModelChatTool[], messages: vscode.LanguageModelChatRequestMessage[] = []) =>
    provider.provideLanguageModelChatResponse(model, messages, { tools, toolMode: vscode.LanguageModelChatToolMode.Required } as vscode.ProvideLanguageModelChatResponseOptions, { report: vi.fn() }, token);
  return { requests, send, model };
}

function manifest(count: number): vscode.LanguageModelChatTool[] {
  return Array.from({ length: count }, (_, i) => ({ name: `mcp_server_tool_${i}`, description: `Tool ${i}`, inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }));
}

function history(count: number, progress: boolean): vscode.LanguageModelChatRequestMessage[] {
  return Array.from({ length: count }, (_, i) => [
    { role: vscode.LanguageModelChatMessageRole.Assistant, name: undefined, content: [new vscode.LanguageModelToolCallPart(`call-${i}`, "mcp_poll", { task: "build" })] },
    { role: vscode.LanguageModelChatMessageRole.User, name: undefined, content: [new vscode.LanguageModelToolResultPart(`call-${i}`, [new vscode.LanguageModelTextPart(progress ? `completed ${i}` : "error: unavailable")])] },
  ]).flat();
}

afterEach(() => { delete configValues["omnicopilot-dev"]; routes.resetAllCooldowns(); vi.restoreAllMocks(); });

describe("host-owned tool forwarding", () => {
  it.each([0, 1, 32, 33, 64, 128, 150, 250])("forwards all %i host tools by default with exact schemas and required choice", async (count) => {
    const { send, requests } = await setup();
    const tools = manifest(count);
    await send(tools);
    expect(requests).toHaveLength(1);
    expect(requests[0].tools ?? []).toEqual(tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })));
    expect(requests[0].tool_choice).toBe("required");
  });

  it("retains maxTools=0 compatibility", async () => {
    configValues["omnicopilot-dev"] = { maxTools: 0 };
    const { send, requests } = await setup();
    await send(manifest(150));
    expect(requests[0].tools).toHaveLength(150);
  });

  it("rejects an explicit local capacity instead of silently removing tools", async () => {
    configValues["omnicopilot-dev"] = { maxTools: 32 };
    const { send, requests } = await setup();
    await expect(send(manifest(33))).rejects.toThrow(/tool.*limit|limit.*tool/i);
    expect(requests).toHaveLength(0);
  });

  it.each([false, true, 32, 150])("advertises discovered capability %s without inventing a limit", async (capacity) => {
    const { model } = await setup(capacity);
    expect(model.capabilities.toolCalling).toBe(capacity);
  });

  it("rejects a manifest exceeding verified model capacity", async () => {
    const { send, requests } = await setup(32);
    await expect(send(manifest(33))).rejects.toThrow(/tool.*limit|limit.*tool/i);
    expect(requests).toHaveLength(0);
  });

  it.each([10, 25, 50, 100])("continues after %i identical calls with changing results", async (count) => {
    const { send, requests } = await setup();
    await send(manifest(1), history(count, true));
    expect(requests).toHaveLength(1);
    expect(requests[0].messages.filter((message) => message.role === "tool")).toHaveLength(count);
  });

  it.each([10, 25, 50, 100])("accepts %i successive host continuation requests", async (count) => {
    const { send, requests } = await setup();
    for (let turn = 0; turn < count; turn++) await send(manifest(1), history(turn, true));
    expect(requests).toHaveLength(count);
  });

  it("does not classify parallel identical calls as sequential no-progress iterations", async () => {
    const { send, requests } = await setup();
    const calls = Array.from({ length: 10 }, (_, i) => new vscode.LanguageModelToolCallPart(`parallel-${i}`, "mcp_poll", { task: "build" }));
    await send(manifest(1), [
      { role: vscode.LanguageModelChatMessageRole.Assistant, name: undefined, content: calls },
      { role: vscode.LanguageModelChatMessageRole.User, name: undefined, content: calls.map((call) => new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart("error: unavailable")])) },
    ]);
    expect(requests[0].messages[0].tool_calls).toHaveLength(10);
    expect(requests[0].messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id)).toEqual(calls.map((call) => call.callId));
  });

  it("treats intervening assistant progress as progress even when tool output is unchanged", async () => {
    const { send, requests } = await setup();
    const messages = history(10, false).map((message) => {
      if (message.role !== vscode.LanguageModelChatMessageRole.Assistant) return message;
      return {
        ...message,
        content: [new vscode.LanguageModelTextPart("Completed another workspace edit"), ...message.content],
      };
    });
    await send(manifest(1), messages);
    expect(requests).toHaveLength(1);
  });

  it("does not infer lack of progress from missing results", async () => {
    const { send, requests } = await setup();
    const calls = history(10, false).filter((message) => message.role === vscode.LanguageModelChatMessageRole.Assistant);
    await send(manifest(1), calls);
    expect(requests).toHaveLength(1);
  });

  it("blocks completed identical failures without progress", async () => {
    const { send, requests } = await setup();
    await expect(send(manifest(1), history(10, false))).rejects.toThrow(/loop|progress/i);
    expect(requests).toHaveLength(0);
  });
});
