import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ConnectionStatusBar } from "../src/statusBar";
import { OmniStatusPopup } from "../src/statusPopup";
import * as routesModule from "../src/routes";
import {
  renderStatusText,
  statusColorTokens,
  type StatusSnapshot,
} from "../src/status/statusRenderer";
import { buildStatusTooltip } from "../src/status/statusTooltip";

const base: StatusSnapshot = {
  status: "online",
  servers: [
    { routeId: "a", name: "Alpha", online: true, latencyMs: 12, tokens: 0, requests: 0 },
    { routeId: "b", name: "Beta", online: false, latencyMs: 900, tokens: 100, requests: 2 },
  ],
  activeRequestCount: 0,
  fallbackCount: 0,
};

describe("statusRenderer", () => {
  it("renders server tally only", () => {
    expect(renderStatusText(base)).toBe("$(circle-filled) OmniCopilot 1/2");
  });

  it("shows streaming icon while generating", () => {
    const snap: StatusSnapshot = {
      ...base,
      status: "streaming",
      activeRequestCount: 1,
      activeModel: "openai/gpt-4o",
    };
    const text = renderStatusText(snap);
    expect(text).toContain("$(loading~spin)");
    expect(text).toContain("OmniCopilot 1/2");
  });

  it("uses the error icon on failure and the outline icon when offline", () => {
    expect(renderStatusText({ ...base, status: "error" })).toMatch(/^\$\(error\)/);
    expect(renderStatusText({ ...base, status: "offline", servers: [] })).toBe(
      "$(circle-outline) OmniCopilot"
    );
  });

  it("maps theme-color tokens per state", () => {
    expect(statusColorTokens({ ...base })).toEqual({ color: "testing.iconPassed" });
    expect(statusColorTokens({ ...base, status: "partial" })).toEqual({
      color: "testing.iconWarning",
    });
    expect(statusColorTokens({ ...base, status: "offline" })).toEqual({
      background: "statusBarItem.warningBackground",
    });
    expect(statusColorTokens({ ...base, status: "error" })).toEqual({
      color: "testing.iconFailed",
    });
    expect(statusColorTokens({ ...base, status: "checking" })).toEqual({});
  });
});

describe("statusTooltip", () => {
  it("surfaces active request, last error and fallback count", () => {
    const snap: StatusSnapshot = {
      ...base,
      status: "error",
      lastError: "fetch failed: connect ECONNREFUSED 127.0.0.1:8080",
      activeRequestCount: 1,
      activeModel: "openai/gpt-4o",
      fallbackCount: 2,
    };
    const md = buildStatusTooltip(snap, "OmniRoute request failed.", {
      totalTokens: 10,
      totalInputTokens: 4,
      totalOutputTokens: 6,
      totalCachedTokens: 0,
      totalReasoningTokens: 0,
      totalRequests: 1,
    });
    const text = md.value;
    expect(text).toContain("Active Request");
    expect(text).toContain("Last Error");
    expect(text).toContain("ECONNREFUSED");
    expect(text).toContain("2 fallback server");
    expect(text).not.toContain("Cached Input");
    expect(text).not.toContain("Reasoning Output");
    expect(text).toContain("Input Provenance");
    expect(text).toContain("Output Provenance");
    expect(text).toContain("reported");
    expect(text).toContain("estimated");
  });

  it("omits optional sections when absent", () => {
    const md = buildStatusTooltip(
      { ...base, status: "checking", servers: [] },
      "Checking OmniRoute connection…",
      undefined
    );
    const text = md.value;
    expect(text).not.toContain("Last Error");
    expect(text).not.toContain("Connected Servers");
  });

  it("renders only positive cached and reasoning subset values", () => {
    const cachedOnly = buildStatusTooltip(
      { ...base, usage: {
        serverName: "Alpha",
        modelName: "gpt-4o",
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 25,
        reasoningTokens: 0,
        inputTokenProvenance: "reported",
        outputTokenProvenance: "reported",
      } },
      "Online",
      undefined
    ).value;
    expect(cachedOnly).toContain("Cached Input");
    expect(cachedOnly).toContain("25");
    expect(cachedOnly).not.toContain("Reasoning Output");

    const reasoningOnly = buildStatusTooltip(
      { ...base, usage: {
        serverName: "Alpha",
        modelName: "reasoning-model",
        inputTokens: 40,
        outputTokens: 12,
        cachedTokens: 0,
        reasoningTokens: 7,
        inputTokenProvenance: "reported",
        outputTokenProvenance: "reported",
      } },
      "Online",
      undefined
    ).value;
    expect(reasoningOnly).not.toContain("Cached Input");
    expect(reasoningOnly).toContain("Reasoning Output");
    expect(reasoningOnly).toContain("7");
  });
});


describe("OmniStatusPopup telemetry rendering", () => {
  type ApplyHtml = () => void;
  const applyHtml = (
    OmniStatusPopup.prototype as unknown as { applyWebviewHtml: ApplyHtml }
  ).applyWebviewHtml;
  let html = "";
  applyHtml.call({
    panel: { webview: { set html(v: string) { html = v; } } },
  } as unknown);

  it("renders conditional subset telemetry and per-side provenance metrics", () => {
    expect(html).toContain('id="subset-tokens-row"');
    expect(html).toContain("display:none");
    expect(html).toContain("subsetTokensRow.style.display");
    expect(html).toContain("'Cached Input: ' + fmtTokens(metrics.totalCachedTokens)");
    expect(html).toContain("'Reasoning Output: ' + fmtTokens(metrics.totalReasoningTokens)");
    expect(html).toContain("Input Provenance");
    expect(html).toContain("Output Provenance");
    expect(html).toContain("totalCachedTokens");
    expect(html).toContain("totalReasoningTokens");
    expect(html).toContain("inputTokenProvenance");
    expect(html).toContain("outputTokenProvenance");
  });
});

describe("OmniStatusPopup model-context relocation contract", () => {
  type ApplyHtml = () => void;
  const applyHtml = (
    OmniStatusPopup.prototype as unknown as { applyWebviewHtml: ApplyHtml }
  ).applyWebviewHtml;

  function popupHtml(): string {
    let html = "";
    applyHtml.call({
      panel: { webview: { set html(value: string) { html = value; } } },
    } as unknown);
    return html;
  }

  afterEach(() => vi.restoreAllMocks());

  it("renders exactly one model selector and one compact context editor", () => {
    const html = popupHtml();

    expect(html.match(/id=["']model-context-select["']/g)).toHaveLength(1);
    expect(html.match(/id=["']model-context-editor["']/g)).toHaveLength(1);
    expect(html).toContain('class="compact-context-editor"');
    expect(html).toContain('data-context-field="mode"');
    expect(html).toContain('data-context-field="maxContextTokens"');
    expect(html).toContain('data-context-field="autoPreset"');
  });

  it("posts the save contract for the model selected in the dropdown", () => {
    const html = popupHtml();

    expect(html).toContain("command: 'saveContextSettings'");
    expect(html).toContain("routeId: selectedModel.routeId");
    expect(html).toContain("modelId: selectedModel.modelId");
    expect(html).toContain("revision: selectedModel.revision");
  });

  it("posts the reset contract for the model selected in the dropdown", () => {
    const html = popupHtml();

    expect(html).toContain("command: 'resetContextSettings'");
    expect(html).toContain("routeId: selectedModel.routeId");
    expect(html).toContain("modelId: selectedModel.modelId");
  });

  it("includes catalog models in the state posted to the popup", async () => {
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([
      { id: "route-a", name: "Server A", baseUrl: "http://a.test/v1" },
    ]);
    vi.spyOn(routesModule, "getClientForRoute").mockReturnValue({
      baseUrl: "http://a.test/v1",
      listModels: vi.fn().mockResolvedValue([
        { id: "vendor/model-a", context_length: 128_000, max_output_tokens: 8_000 },
      ]),
    } as never);

    let receive: ((message: { command: string; value?: unknown }) => Promise<void>) | undefined;
    const posted: Array<{ command?: string; state?: Record<string, unknown> }> = [];
    const panel = {
      visible: true,
      webview: {
        html: "",
        onDidReceiveMessage: vi.fn((handler) => {
          receive = handler;
          return { dispose: () => {} };
        }),
        postMessage: vi.fn(async (message) => { posted.push(message); return true; }),
      },
      onDidDispose: vi.fn(() => ({ dispose: () => {} })),
      dispose: vi.fn(),
    } as unknown as vscode.WebviewPanel;
    const context = {
      extensionUri: { scheme: "file", path: "/extension" },
      globalState: { get: vi.fn((_key: string, fallback: unknown) => fallback), update: vi.fn() },
    } as unknown as vscode.ExtensionContext;
    const metrics = {
      onDidChangeMetrics: vi.fn(() => ({ dispose: () => {} })),
      getMetrics: vi.fn(() => ({
        servers: {}, totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0,
        totalCachedTokens: 0, totalReasoningTokens: 0,
        inputTokenProvenance: { reported: 0, estimated: 0, unknown: 0 },
        outputTokenProvenance: { reported: 0, estimated: 0, unknown: 0 },
        totalRequests: 0,
      })),
      generateSuggestions: vi.fn(() => []),
    };
    const statusBar = {
      onDidChangeSnapshot: vi.fn(() => ({ dispose: () => {} })),
      getSnapshot: vi.fn(() => ({ ...base, servers: [
        { routeId: "route-a", name: "Server A", online: true, latencyMs: 5, tokens: 0, requests: 0 },
      ] })),
    };
    type PopupConstructor = new (
      panel: vscode.WebviewPanel,
      context: vscode.ExtensionContext,
      metricsArg: typeof metrics,
      log: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> },
      statusBarArg: typeof statusBar
    ) => OmniStatusPopup;
    const Popup = OmniStatusPopup as unknown as PopupConstructor;
    new Popup(panel, context, metrics, { info: vi.fn(), error: vi.fn() }, statusBar);

    expect(receive).toBeDefined();
    await receive?.({ command: "ready" });

    expect(posted).toContainEqual(expect.objectContaining({
      command: "updateState",
      state: expect.objectContaining({
        models: [expect.objectContaining({
          routeId: "route-a",
          routeName: "Server A",
          modelId: "vendor/model-a",
          providerMaxContext: 128_000,
        })],
      }),
    }));
  });
});

describe("ConnectionStatusBar concurrency tracking", () => {
  it("keeps streaming state while any concurrent request is active", () => {
    const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
    const bar = new ConnectionStatusBar(async () => [], mockLog);

    bar.reportRequestStart("r1", "gpt-4o");
    expect(bar.getSnapshot().status).toBe("streaming");
    expect(bar.getSnapshot().activeRequestCount).toBe(1);

    bar.reportRequestStart("r1", "claude-sonnet");
    expect(bar.getSnapshot().status).toBe("streaming");
    expect(bar.getSnapshot().activeRequestCount).toBe(2);

    // First request finishes: active count becomes 1, status stays streaming
    bar.reportRequestEnd(true, undefined, 0);
    expect(bar.getSnapshot().status).toBe("streaming");
    expect(bar.getSnapshot().activeRequestCount).toBe(1);

    // Second request finishes: active count becomes 0
    bar.reportRequestEnd(true, undefined, 0);
    expect(bar.getSnapshot().activeRequestCount).toBe(0);
    expect(bar.getSnapshot().status).not.toBe("streaming");

    bar.dispose();
  });
});

describe("OmniStatusPopup command handling", () => {
  type RunCommand = (value: unknown) => Promise<void>;
  const handleRunCommand = (
    OmniStatusPopup.prototype as unknown as { handleRunCommand: RunCommand }
  ).handleRunCommand;

  afterEach(() => vi.restoreAllMocks());

  it("allows opening a specific setting and forwards its argument", async () => {
    const executeCommand = vi.spyOn(vscode.commands, "executeCommand");

    await handleRunCommand.call({}, {
      cmd: "workbench.action.openSettings",
      args: ["omnicopilot-dev.fallbackMode"],
    });

    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith(
      "workbench.action.openSettings",
      "omnicopilot-dev.fallbackMode"
    );
  });

  it("rejects unrelated commands without forwarding their arguments", async () => {
    const executeCommand = vi.spyOn(vscode.commands, "executeCommand");

    await handleRunCommand.call({}, {
      cmd: "workbench.action.closeWindow",
      args: ["must-not-be-forwarded"],
    });

    expect(executeCommand).not.toHaveBeenCalled();
  });
});

describe("OmniStatusPopup online status rendering", () => {
  type ApplyHtml = () => void;
  const applyHtml = (
    OmniStatusPopup.prototype as unknown as { applyWebviewHtml: ApplyHtml }
  ).applyWebviewHtml;
  // Call applyWebviewHtml with a mock `this` that captures the HTML
  // assigned to panel.webview.html.
  let html = "";
  applyHtml.call({
    panel: { webview: { set html(v: string) { html = v; } } },
  } as unknown);
  const latencyExpression = html.match(/\$\{(s\.online \?[^}]+: "Offline")\}/)?.[1];

  if (!latencyExpression) {
    throw new Error("Unable to locate the server latency expression in the status popup HTML.");
  }

  const renderLatency = new Function("s", `return (${latencyExpression});`) as (
    server: { online: boolean; latencyMs?: number }
  ) => string;

  it.each([
    { label: "undefined latency", server: { online: true }, expected: "Online" },
    { label: "zero latency", server: { online: true, latencyMs: 0 }, expected: "0ms" },
    { label: "positive latency", server: { online: true, latencyMs: 37 }, expected: "37ms" },
    { label: "offline", server: { online: false, latencyMs: 37 }, expected: "Offline" },
  ])("renders $expected for $label", ({ server, expected }) => {
    expect(renderLatency(server)).toBe(expected);
  });
});