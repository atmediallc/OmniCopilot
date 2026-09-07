import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { OmniPanelProvider } from "../src/panel";
import * as routesModule from "../src/routes";

function harness() {
  const context = {
    extensionUri: { scheme: "file", path: "/extension" },
  } as unknown as vscode.ExtensionContext;
  let html = "";
  const view = {
    visible: false,
    webview: {
      options: {},
      set html(value: string) { html = value; },
      get html() { return html; },
      postMessage: vi.fn(async () => true),
      onDidReceiveMessage: vi.fn(() => ({ dispose: () => {} })),
    },
    onDidChangeVisibility: vi.fn(() => ({ dispose: () => {} })),
  } as unknown as vscode.WebviewView;
  const provider = new OmniPanelProvider(
    context,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    vi.fn(async () => {})
  );
  return {
    context,
    provider,
    view,
    html: () => html,
  };
}

describe("management sidebar context relocation", () => {
  it("no longer contains the model-context editor or its message contracts", () => {
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([]);
    const panel = harness();
    panel.provider.resolveWebviewView(panel.view);
    const html = panel.html();

    expect(html).not.toContain('id="models"');
    expect(html).not.toContain("data-context-field");
    expect(html).not.toContain('type: "saveContextSettings"');
    expect(html).not.toContain('type: "resetContextSettings"');
  });

  it("contains syntactically valid client-side javascript in script tag", () => {
    vi.spyOn(routesModule, "cachedLoadRoutes").mockResolvedValue([]);
    const panel = harness();
    panel.provider.resolveWebviewView(panel.view);
    const html = panel.html();
    const scriptMatch = /<script\b[^>]*>([\s\S]*?)<\/script>/i.exec(html);
    expect(scriptMatch).not.toBeNull();
    const scriptContent = scriptMatch![1];
    expect(() => new Function(scriptContent)).not.toThrow();
  });
});
