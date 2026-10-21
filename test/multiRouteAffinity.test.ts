import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { OmniRouteChatProvider } from "../src/provider";
import { OmniRouteError } from "../src/client";
import * as routes from "../src/routes";
import { configValues } from "./vscode.mock";
import type { ChatRequest, OmniRouteModel } from "../src/types";

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as unknown as vscode.LogOutputChannel;
const metadata: OmniRouteModel = { id: "vendor/exact", context_length: 128000, capabilities: { tool_calling: true, vision: false } };
const user = (text: string) => ({ role: vscode.LanguageModelChatMessageRole.User, name: undefined, content: [new vscode.LanguageModelTextPart(text)] });

async function setup(models: OmniRouteModel[] = [metadata, metadata, metadata]) {
  configValues["omnicopilot-dev"] = { retriesPerServer: 0 };
  const store = new Map<string, unknown>();
  const context = { globalState: {
    get: (key: string, fallback?: unknown) => store.get(key) ?? fallback,
    update: async (key: string, value: unknown) => { store.set(key, value); },
  } } as unknown as vscode.ExtensionContext;
  const attempts: Array<{ route: string; request: ChatRequest }> = [];
  const failures = new Map<string, Error>();
  const clients = Object.fromEntries(["A", "B", "C"].map((id, i) => [id, {
    baseUrl: `http://${id.toLowerCase()}.test/v1`,
    listModels: async () => [models[i]],
    streamModel: async function* (request: ChatRequest) {
      attempts.push({ route: id, request });
      const error = failures.get(id);
      if (error) throw error;
      yield { kind: "text", text: id };
    },
  }]));
  vi.spyOn(routes, "cachedLoadRoutes").mockResolvedValue(Object.entries(clients).map(([id, client]) => ({ id, name: `Server ${id}`, baseUrl: client.baseUrl })));
  vi.spyOn(routes, "getClientForRoute").mockImplementation(((route: routes.Route) => clients[route.id]) as never);
  const provider = new OmniRouteChatProvider({ context, log });
  await provider.refresh();
  const infos = await provider.provideLanguageModelChatInformation({ silent: true }, token);
  const send = (session: string, selected = infos[0], interactive = true, messages = [user(session)]) =>
    provider.provideLanguageModelChatResponse(selected, messages, {
      modelOptions: { conversationId: session, interactive },
    } as never, { report: vi.fn() }, token);
  return { provider, context, attempts, failures, infos, send, clients };
}

afterEach(() => { delete configValues["omnicopilot-dev"]; routes.resetAllCooldowns(); vi.restoreAllMocks(); });

describe("strict conversation route affinity", () => {
  it("keeps healthy selected primary even when it is cooling down", async () => {
    const { attempts, send } = await setup();
    routes.markRouteCooldown("A", 60000, 503);
    await send("healthy");
    expect(attempts.map((a) => a.route)).toEqual(["A"]);
  });

  it.each([429, 500, 502, 503, 504, undefined])("never switches on %s without authorization", async (status) => {
    const { attempts, send, failures } = await setup();
    failures.set("A", new OmniRouteError("primary unavailable", status));
    await expect(send("denied")).rejects.toThrow();
    expect(attempts.map((a) => a.route)).toEqual(["A"]);
  });

  it("switches only after approval and pins exact model for later turns", async () => {
    const { attempts, send, failures } = await setup();
    failures.set("A", new OmniRouteError("down", 503));
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Authorize switch to Server B" as never);
    await send("approved");
    failures.delete("A");
    await send("approved");
    expect(attempts.map((a) => a.route)).toEqual(["A", "B", "B"]);
    expect(attempts.map((a) => a.request.model)).toEqual(["vendor/exact", "vendor/exact", "vendor/exact"]);
  });

  it("retries only current server when requested", async () => {
    const { attempts, send, failures } = await setup();
    failures.set("A", new OmniRouteError("down", 503));
    vi.spyOn(vscode.window, "showWarningMessage").mockImplementation(async () => {
      failures.delete("A");
      return "Retry Current Server" as never;
    });
    await send("retry");
    expect(attempts.map((a) => a.route)).toEqual(["A", "A"]);
  });

  it("fails closed without prompting in unattended requests", async () => {
    const { attempts, send, failures } = await setup();
    failures.set("A", new OmniRouteError("down", 503));
    const prompt = vi.spyOn(vscode.window, "showWarningMessage");
    await expect(send("headless", undefined, false)).rejects.toThrow();
    expect(prompt).not.toHaveBeenCalled();
    expect(attempts.map((a) => a.route)).toEqual(["A"]);
  });

  it("does not inherit another conversation's approved switch", async () => {
    const { attempts, send, failures, infos } = await setup();
    failures.set("A", new OmniRouteError("down", 503));
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Authorize switch to Server B" as never);
    await send("one");
    failures.delete("A");
    await Promise.all([send("one"), send("two"), send("three", infos[2])]);
    expect(attempts.slice(2).map((a) => a.route).sort()).toEqual(["A", "B", "C"]);
  });

  it("refuses an implicit model change inside pinned conversation", async () => {
    const other = { ...metadata, id: "vendor/other" };
    const { attempts, send, infos } = await setup([metadata, metadata, other]);
    await send("same-session");
    await expect(send("same-session", infos[2])).rejects.toThrow(/model|identity/i);
    expect(attempts.map((a) => a.route)).toEqual(["A"]);
  });

  it("serializes concurrent turns so approval cannot race a stale primary dispatch", async () => {
    const { attempts, send, failures } = await setup();
    failures.set("A", new OmniRouteError("down", 503));
    let approve!: (value: never) => void;
    const prompt = vi.spyOn(vscode.window, "showWarningMessage").mockImplementationOnce(() => new Promise((resolve) => { approve = resolve; })).mockResolvedValue(undefined);
    const first = send("overlap");
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    const second = send("overlap");
    approve("Authorize switch to Server B" as never);
    await Promise.all([first, second]);
    expect(attempts.map((a) => a.route)).toEqual(["A", "B", "B"]);
  });

  it("does not oscillate after two failing servers without a second approval", async () => {
    const { attempts, send, failures } = await setup();
    failures.set("A", new OmniRouteError("down", 503));
    failures.set("B", new OmniRouteError("down", 503));
    vi.spyOn(vscode.window, "showWarningMessage")
      .mockResolvedValueOnce("Authorize switch to Server B" as never)
      .mockResolvedValueOnce(undefined);
    await expect(send("no-oscillation")).rejects.toThrow();
    expect(attempts.map((a) => a.route)).toEqual(["A", "B"]);
  });

  it("does not replay a partially emitted tool call on another server", async () => {
    const { provider, infos, clients, attempts } = await setup();
    clients.A.streamModel = async function* (request: ChatRequest) {
      attempts.push({ route: "A", request });
      yield { kind: "tool_call", id: "call-1", name: "edit", args: "{\"path\":\"a.ts\"}" } as never;
      throw new OmniRouteError("stream stalled", undefined, true, "stream");
    };
    const prompt = vi.spyOn(vscode.window, "showWarningMessage");
    await expect(provider.provideLanguageModelChatResponse(infos[0], [user("tool")], {
      modelOptions: { conversationId: "tool", interactive: true },
      tools: [{ name: "edit", description: "edit", inputSchema: { type: "object" } }],
    } as never, { report: vi.fn() }, token)).rejects.toThrow();
    expect(attempts.map((a) => a.route)).toEqual(["A"]);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("fails closed without a stable caller session identity", async () => {
    const { provider, infos, failures, attempts } = await setup();
    failures.set("A", new OmniRouteError("down", 503));
    const prompt = vi.spyOn(vscode.window, "showWarningMessage");
    await expect(provider.provideLanguageModelChatResponse(infos[0], [user("same prompt")], {} as never, { report: vi.fn() }, token)).rejects.toThrow();
    expect(attempts.map((a) => a.route)).toEqual(["A"]);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("does not infer session identity or share authorization based on identical message text", async () => {
    const { provider, infos, failures, attempts } = await setup();
    failures.set("A", new OmniRouteError("down", 503));
    const prompt = vi.spyOn(vscode.window, "showWarningMessage");
    const msg = [user("common system instruction prefix")];
    await expect(provider.provideLanguageModelChatResponse(infos[0], msg, {} as never, { report: vi.fn() }, token)).rejects.toThrow();
    await expect(provider.provideLanguageModelChatResponse(infos[0], msg, {} as never, { report: vi.fn() }, token)).rejects.toThrow();
    expect(attempts.map((a) => a.route)).toEqual(["A", "A"]);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("restores authorized affinity after provider recreation", async () => {
    const { attempts, send, failures, infos, context } = await setup();
    failures.set("A", new OmniRouteError("down", 503));
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Authorize switch to Server B" as never);
    await send("restored");
    failures.delete("A");
    const restored = new OmniRouteChatProvider({ context, log });
    await restored.provideLanguageModelChatResponse(infos[0], [user("restored")], { modelOptions: { conversationId: "restored", interactive: true } } as never, { report: vi.fn() }, token);
    expect(attempts.map((a) => a.route)).toEqual(["A", "B", "B"]);
  });
});
