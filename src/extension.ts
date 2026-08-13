import * as vscode from "vscode";
import { OmniRouteClient, normalizeBaseUrl, serverRootUrl } from "./client";
import { configureCliTool } from "./cliBridge";
import { OmniRouteChatProvider, SECRET_API_KEY } from "./provider";
import { ConnectionStatusBar } from "./statusBar";

const OMNIROUTE_REPO = "https://github.com/diegosouzapw/OmniRoute";
const VENDOR = "omniroute";

let provider: OmniRouteChatProvider | undefined;
let statusBar: ConnectionStatusBar | undefined;

function getConfig() {
  return vscode.workspace.getConfiguration("omnicopilot");
}

async function makeClient(context: vscode.ExtensionContext): Promise<OmniRouteClient> {
  const baseUrl = getConfig().get<string>("baseUrl", "http://localhost:20128/v1");
  const apiKey = await context.secrets.get(SECRET_API_KEY);
  return new OmniRouteClient({ baseUrl, apiKey: apiKey || undefined });
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("OmniRoute for Copilot", { log: true });
  context.subscriptions.push(log);
  log.info(`Activating v${context.extension.packageJSON.version}`);

  statusBar = new ConnectionStatusBar(() => makeClient(context), log);
  context.subscriptions.push(statusBar);

  provider = new OmniRouteChatProvider({
    context,
    log,
    onActivity: (ok) => statusBar?.reportActivity(ok),
  });
  context.subscriptions.push(provider);
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(VENDOR, provider));
  log.info(`Language model chat provider registered (vendor: ${VENDOR})`);

  registerCommands(context, log);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("omnicopilot")) return;
      log.info("Configuration changed — refreshing models and status");
      statusBar?.restart();
      void provider?.refresh();
    })
  );

  statusBar.start();
  void checkFirstRun(context, log);
}

function registerCommands(context: vscode.ExtensionContext, log: vscode.LogOutputChannel): void {
  const register = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register("omnicopilot.manage", () => manageConnection(context, log));
  register("omnicopilot.setApiKey", () => setApiKey(context, log));

  register("omnicopilot.refreshModels", async () => {
    await provider?.refresh();
    void vscode.window.showInformationMessage("OmniRoute model list refreshed.");
  });

  register("omnicopilot.checkConnection", async () => {
    const ok = await statusBar?.checkNow();
    if (ok) {
      const client = await makeClient(context);
      void vscode.window.showInformationMessage(`Connected to OmniRoute at ${client.baseUrl}.`);
    } else {
      void vscode.window.showWarningMessage(
        "OmniRoute is unreachable. Check that it is running (npx omniroute) and that omnicopilot.baseUrl points at it."
      );
    }
  });

  register("omnicopilot.openDashboard", () => {
    const root = serverRootUrl(getConfig().get<string>("baseUrl", "http://localhost:20128/v1"));
    void vscode.env.openExternal(vscode.Uri.parse(root));
  });

  register("omnicopilot.openGitHub", () => {
    void vscode.env.openExternal(vscode.Uri.parse(OMNIROUTE_REPO));
  });

  register("omnicopilot.installOmniRoute", async () => {
    const pick = await vscode.window.showInformationMessage(
      "OmniRoute is a free, open-source AI router: one endpoint, 339 providers, auto-fallback. Install it with npm and this extension lights up automatically.",
      "Copy install command",
      "Open GitHub"
    );
    if (pick === "Copy install command") {
      await vscode.env.clipboard.writeText("npm install -g omniroute && omniroute");
      void vscode.window.showInformationMessage(
        'Copied "npm install -g omniroute && omniroute" — paste it in any terminal.'
      );
    } else if (pick === "Open GitHub") {
      void vscode.env.openExternal(vscode.Uri.parse(OMNIROUTE_REPO));
    }
  });

  register("omnicopilot.configureCliTool", (toolId?: unknown) =>
    configureCliTool(context, log, typeof toolId === "string" ? toolId : undefined)
  );

  register("omnicopilot.quickActions", () => quickActions(context));
}

/** Menu behind the status-bar item. */
async function quickActions(context: vscode.ExtensionContext): Promise<void> {
  const client = await makeClient(context);
  const online = await client.ping(1500);

  const items: Array<vscode.QuickPickItem & { action: string }> = [
    {
      label: online ? "$(circle-filled) Online" : "$(circle-outline) Offline",
      description: client.baseUrl,
      action: "check",
    },
    { label: "$(gear) Configure connection (URL / API key)", action: "manage" },
    { label: "$(sync) Refresh models", action: "refresh" },
    { label: "$(dashboard) Open OmniRoute dashboard", action: "dashboard" },
    { label: "$(terminal) Configure a coding CLI (Codex, Claude Code…)", action: "cli" },
    { label: "$(github) OmniRoute on GitHub", action: "github" },
  ];
  if (!online) {
    items.splice(1, 0, {
      label: "$(cloud-download) Install OmniRoute",
      description: "npm i -g omniroute",
      action: "install",
    });
  }

  const picked = await vscode.window.showQuickPick(items, { title: "OmniRoute" });
  const commandByAction: Record<string, string> = {
    check: "omnicopilot.checkConnection",
    manage: "omnicopilot.manage",
    refresh: "omnicopilot.refreshModels",
    dashboard: "omnicopilot.openDashboard",
    cli: "omnicopilot.configureCliTool",
    github: "omnicopilot.openGitHub",
    install: "omnicopilot.installOmniRoute",
  };
  if (picked) void vscode.commands.executeCommand(commandByAction[picked.action]);
}

/** Management command wired to the provider (gear icon in Manage Models). */
async function manageConnection(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel
): Promise<void> {
  const cfg = getConfig();
  const current = cfg.get<string>("baseUrl", "http://localhost:20128/v1");

  const url = await vscode.window.showInputBox({
    title: "OmniRoute server URL",
    prompt: "Where is your OmniRoute running? Local default is http://localhost:20128/v1",
    value: current,
    ignoreFocusOut: true,
  });
  if (url === undefined) return;

  const normalized = normalizeBaseUrl(url);
  await cfg.update("baseUrl", normalized, vscode.ConfigurationTarget.Global);
  log.info(`Base URL set to ${normalized}`);

  await setApiKey(context, log, true);

  const ok = await statusBar?.checkNow();
  await provider?.refresh();
  void vscode.window.showInformationMessage(
    ok
      ? `Connected — OmniRoute models are now available in the Copilot Chat model picker.`
      : `Saved ${normalized}, but the server did not respond. Start OmniRoute and run "OmniRoute: Check Connection".`
  );
}

async function setApiKey(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  optionalFlow = false
): Promise<void> {
  const existing = await context.secrets.get(SECRET_API_KEY);
  const key = await vscode.window.showInputBox({
    title: "OmniRoute API key",
    prompt: optionalFlow
      ? "Optional — leave empty if your OmniRoute does not require an API key. Stored in the OS keychain."
      : "Stored securely in the OS keychain (SecretStorage). Leave empty to clear.",
    value: existing ?? "",
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) return;

  if (key.trim()) {
    await context.secrets.store(SECRET_API_KEY, key.trim());
    log.info("API key stored in SecretStorage");
  } else if (existing) {
    await context.secrets.delete(SECRET_API_KEY);
    log.info("API key cleared");
  }
  if (!optionalFlow) await provider?.refresh();
}

/** One-time welcome: point users at the model picker or at installing OmniRoute. */
async function checkFirstRun(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel
): Promise<void> {
  const FLAG = "omnicopilot.welcomed";
  if (context.globalState.get<boolean>(FLAG)) return;
  await context.globalState.update(FLAG, true);

  const client = await makeClient(context);
  const online = await client.ping();
  log.info(`First run — OmniRoute ${online ? "detected" : "not detected"} at ${client.baseUrl}`);

  if (online) {
    const pick = await vscode.window.showInformationMessage(
      "OmniRoute detected! Your models are ready — open the Copilot Chat model picker and choose any OmniRoute model.",
      "How to pick a model"
    );
    if (pick) {
      void vscode.env.openExternal(
        vscode.Uri.parse("https://code.visualstudio.com/docs/agent-customization/language-models")
      );
    }
  } else {
    const pick = await vscode.window.showInformationMessage(
      "OmniCopilot: bring 1000+ AI models to Copilot Chat with OmniRoute — free and open source. No OmniRoute server detected yet.",
      "Install OmniRoute",
      "Configure connection"
    );
    if (pick === "Install OmniRoute") {
      void vscode.commands.executeCommand("omnicopilot.installOmniRoute");
    } else if (pick === "Configure connection") {
      void vscode.commands.executeCommand("omnicopilot.manage");
    }
  }
}

export function deactivate(): void {
  provider = undefined;
  statusBar = undefined;
}
