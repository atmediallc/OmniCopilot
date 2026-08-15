import * as vscode from "vscode";
import { serverRootUrl } from "./client";
import { configureCliTool } from "./cliBridge";
import { OmniPanelProvider } from "./panel";
import { OmniRouteChatProvider } from "./provider";
import { SECRET_PREFIX, loadRoutes, makeClientForRoute } from "./routes";
import { ConnectionStatusBar } from "./statusBar";
import { MetricsTracker } from "./metrics";
import { OmniStatusPopup } from "./statusPopup";

const OMNIROUTE_REPO = "https://github.com/diegosouzapw/OmniRoute";
const VENDOR = "omniroute";

let activeProviders: OmniRouteChatProvider[] = [];
let providerDisposables: vscode.Disposable[] = [];
let statusBar: ConnectionStatusBar | undefined;
let panel: OmniPanelProvider | undefined;
let metricsTracker: MetricsTracker | undefined;
let syncPromise: Promise<void> = Promise.resolve();

function getConfig() {
  return vscode.workspace.getConfiguration("omnicopilot");
}

async function refreshAll(): Promise<void> {
  for (const p of activeProviders) {
    await p.refresh();
  }
}

function syncProviders(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel
): Promise<void> {
  syncPromise = syncPromise.then(() => doSyncProviders(context, log)).catch((err) => {
    log.error(`Failed to sync providers: ${String(err)}`);
  });
  return syncPromise;
}

async function doSyncProviders(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel
): Promise<void> {
  for (const d of providerDisposables) {
    d.dispose();
  }
  providerDisposables = [];
  activeProviders = [];

  const routes = await loadRoutes(context);
  const activeRoutes = routes.slice(0, 10);
  if (routes.length > 10) {
    log.warn(
      `OmniRoute supports up to 10 active servers simultaneously. Truncating ${routes.length} configured servers to 10.`
    );
  }

  const deps = {
    context,
    log,
    onActivity: (ok: boolean, routeId?: string) => statusBar?.reportActivity(ok, routeId),
    onUsage: (usage: { routeId?: string; baseUrl?: string; serverName: string; modelName: string; inputTokens: number; outputTokens: number }) =>
      statusBar?.reportUsage(usage),
    getOnlineRouteIds: () => statusBar?.onlineRouteIds(),
  };

  if (activeRoutes.length <= 1) {
    const p = new OmniRouteChatProvider(deps);
    try {
      const reg = vscode.lm.registerLanguageModelChatProvider(VENDOR, p);
      activeProviders.push(p);
      providerDisposables.push(p, reg);
      log.info(`Registered provider for vendor "${VENDOR}" (${activeRoutes.length} server(s) configured)`);
    } catch (err) {
      log.error(`Failed to register chat provider for vendor "${VENDOR}": ${String(err)}`);
    }
  } else {
    activeRoutes.forEach((route, index) => {
      const vendorId = index === 0 ? VENDOR : `omniroute-${index + 1}`;
      const p = new OmniRouteChatProvider(deps, route.id);
      try {
        const reg = vscode.lm.registerLanguageModelChatProvider(vendorId, p);
        activeProviders.push(p);
        providerDisposables.push(p, reg);
        log.info(`Registered provider for server "${route.name}" under vendor slot "${vendorId}" (routeId: ${route.id})`);
      } catch (err) {
        log.error(`Failed to register chat provider for vendor "${vendorId}" (server: ${route.name}): ${String(err)}`);
      }
    });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("OmniRoute for Copilot", { log: true });
  context.subscriptions.push(log);
  log.info(`Activating v${context.extension.packageJSON.version}`);

  OmniRouteChatProvider.loadPersistentCache(context);

  metricsTracker = new MetricsTracker(context);

  statusBar = new ConnectionStatusBar(
    async () => {
      return loadRoutes(context);
    },
    log,
    metricsTracker
  );
  context.subscriptions.push(statusBar);

  void syncProviders(context, log);

  panel = new OmniPanelProvider(context, log, async () => {
    statusBar?.restart();
    await syncProviders(context, log);
    await refreshAll();
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(OmniPanelProvider.viewId, panel)
  );

  registerCommands(context, log, refreshAll);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("omnicopilot")) return;
      log.info("Configuration changed — refreshing models and status");
      statusBar?.restart();
      void syncProviders(context, log).then(() => refreshAll());
      void panel?.refreshStatus();
    })
  );

  statusBar.start();
  void checkFirstRun(context, log);
}

function registerCommands(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  onRefresh: () => Promise<void>
): void {
  const register = (id: string, fn: (...args: readonly unknown[]) => void | Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // The management gear in "Manage Models" and the status-bar menu both land
  // on the visual panel (Activity Bar view) where URL + API key live.
  register("omnicopilot.manage", () => panel?.focus());
  register("omnicopilot.setApiKey", () => setApiKey(context, log));

  register("omnicopilot.refreshModels", async () => {
    await onRefresh();
    const routes = await loadRoutes(context);
    if (activeProviders.length > 0) {
      const cts = new vscode.CancellationTokenSource();
      const models = await activeProviders[0].provideLanguageModelChatInformation({ silent: true }, cts.token);
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Models synced: {0} model(s) found across {1} server(s).", models.length, routes.length)
      );
    } else {
      void vscode.window.showInformationMessage(vscode.l10n.t("Model list updated."));
    }
  });

  register("omnicopilot.checkConnection", async () => {
    const ok = await statusBar?.checkNow();
    if (ok) {
      const routes = await loadRoutes(context);
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Connected to OmniRoute at {0}.", routes[0]?.baseUrl ?? "")
      );
    } else {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          "OmniRoute is unreachable. Check that it is running (npx omniroute) and that omnicopilot.routes is configured."
        )
      );
    }
  });

  register("omnicopilot.openDashboard", async () => {
    const routes = await loadRoutes(context);
    if (routes.length === 0) return;
    let root: string;
    if (routes.length === 1) {
      root = serverRootUrl(routes[0].baseUrl);
    } else {
      const picked = await vscode.window.showQuickPick(
        routes.map((r) => ({
          label: r.name,
          description: serverRootUrl(r.baseUrl),
          route: r,
        })),
        { title: vscode.l10n.t("OmniRoute: open dashboard") }
      );
      if (!picked) return;
      root = serverRootUrl(picked.route.baseUrl);
    }
    const mode = getConfig().get<string>("dashboardOpen", "external");
    if (mode === "editor") {
      // Simple Browser renders the dashboard in an editor tab. Needs an
      // OmniRoute build whose CSP allows embedding (frame-ancestors).
      try {
        await vscode.commands.executeCommand("simpleBrowser.show", root);
        return;
      } catch (err) {
        log.warn(`Simple Browser unavailable, falling back to external: ${String(err)}`);
      }
    }
    void vscode.env.openExternal(vscode.Uri.parse(root));
  });

  register("omnicopilot.openGitHub", () => {
    void vscode.env.openExternal(vscode.Uri.parse(OMNIROUTE_REPO));
  });

  register("omnicopilot.installOmniRoute", async () => {
    const copyLabel = vscode.l10n.t("Copy install command");
    const githubLabel = vscode.l10n.t("Open GitHub");
    const pick = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        "OmniRoute is a free, open-source AI router: one endpoint, 330+ providers (90+ free), auto-fallback. Install it with npm and this extension lights up automatically."
      ),
      copyLabel,
      githubLabel
    );
    if (pick === copyLabel) {
      await vscode.env.clipboard.writeText("npm install -g omniroute && omniroute");
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Copied "{0}" — paste it in any terminal.', "npm install -g omniroute && omniroute")
      );
    } else if (pick === githubLabel) {
      void vscode.env.openExternal(vscode.Uri.parse(OMNIROUTE_REPO));
    }
  });

  register("omnicopilot.configureCliTool", (toolId?: unknown) =>
    configureCliTool(context, log, typeof toolId === "string" ? toolId : undefined)
  );

  register("omnicopilot.showStatusPopup", () => {
    if (metricsTracker) {
      OmniStatusPopup.show(context, metricsTracker, log);
    }
  });

  register("omnicopilot.quickActions", () => {
    if (metricsTracker) {
      OmniStatusPopup.show(context, metricsTracker, log);
    } else {
      void quickActions(context, log);
    }
  });
}

/** Menu behind the status-bar item. */
async function quickActions(context: vscode.ExtensionContext, log?: vscode.LogOutputChannel): Promise<void> {
  const routes = await loadRoutes(context);
  const results = await Promise.all(routes.map((r) => makeClientForRoute(r, log).ping(4000)));
  const onlineCount = results.filter(Boolean).length;
  const online = onlineCount > 0;

  const items: Array<vscode.QuickPickItem & { action: string }> = [
    {
      label: online
        ? `$(circle-filled) ${vscode.l10n.t("Online")}`
        : `$(circle-outline) ${vscode.l10n.t("Offline")}`,
      description:
        routes.length === 1
          ? routes[0].baseUrl
          : `${vscode.l10n.t("{0}/{1} online", String(onlineCount), String(routes.length))}`,
      action: "check",
    },
    { label: `$(gear) ${vscode.l10n.t("Configure connection (URL / API key)")}`, action: "manage" },
    { label: `$(sync) ${vscode.l10n.t("Refresh models")}`, action: "refresh" },
    { label: `$(dashboard) ${vscode.l10n.t("Open OmniRoute dashboard")}`, action: "dashboard" },
    {
      label: `$(terminal) ${vscode.l10n.t("Configure a coding CLI (Codex, Claude Code…)")}`,
      action: "cli",
    },
    { label: `$(github) ${vscode.l10n.t("OmniRoute on GitHub")}`, action: "github" },
  ];
  if (!online) {
    items.splice(1, 0, {
      label: `$(cloud-download) ${vscode.l10n.t("Install OmniRoute")}`,
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

async function setApiKey(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  optionalFlow = false
): Promise<void> {
  const routes = await loadRoutes(context);
  if (routes.length === 0) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t("Add a route in the OmniRoute panel first, then set its API key.")
    );
    return;
  }
  let route = routes[0];
  if (routes.length > 1) {
    const picked = await vscode.window.showQuickPick(
      routes.map((r) => ({ label: r.name, description: r.baseUrl, route: r })),
      { title: vscode.l10n.t("OmniRoute: pick a server") }
    );
    if (!picked) return;
    route = picked.route;
  }

  const existing = await context.secrets.get(SECRET_PREFIX + route.id);
  const key = await vscode.window.showInputBox({
    title: vscode.l10n.t("OmniRoute API key — {0}", route.name),
    prompt: optionalFlow
      ? vscode.l10n.t(
          "Optional — leave empty if this server does not require an API key. Stored in the OS keychain."
        )
      : vscode.l10n.t("Stored securely in the OS keychain (SecretStorage). Leave empty to clear."),
    value: existing ?? "",
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) return;

  if (key.trim()) {
    await context.secrets.store(SECRET_PREFIX + route.id, key.trim());
    log.info(`API key stored in SecretStorage (${route.id})`);
  } else if (existing) {
    await context.secrets.delete(SECRET_PREFIX + route.id);
    log.info(`API key cleared (${route.id})`);
  }
  if (!optionalFlow) await refreshAll();
}

/** One-time welcome: point users at the model picker or at installing OmniRoute. */
async function checkFirstRun(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel
): Promise<void> {
  const FLAG = "omnicopilot.welcomed";
  if (context.globalState.get<boolean>(FLAG)) return;
  await context.globalState.update(FLAG, true);

  const routes = await loadRoutes(context);
  const results = await Promise.all(routes.map((r) => makeClientForRoute(r).ping()));
  const online = results.some(Boolean);
  log.info(`First run — OmniRoute ${online ? "detected" : "not detected"} (${routes.length} route(s))`);

  if (online) {
    const pick = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        "OmniRoute detected! Your models are ready — open the Copilot Chat model picker and choose any OmniRoute model."
      ),
      vscode.l10n.t("How to pick a model")
    );
    if (pick) {
      void vscode.env.openExternal(
        vscode.Uri.parse("https://code.visualstudio.com/docs/agent-customization/language-models")
      );
    }
  } else {
    const installLabel = vscode.l10n.t("Install OmniRoute");
    const configureLabel = vscode.l10n.t("Configure connection");
    const pick = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        "OmniCopilot: bring 1200+ AI models to Copilot Chat with OmniRoute — 90+ free providers, free forever. No OmniRoute server detected yet."
      ),
      installLabel,
      configureLabel
    );
    if (pick === installLabel) {
      void vscode.commands.executeCommand("omnicopilot.installOmniRoute");
    } else if (pick === configureLabel) {
      void vscode.commands.executeCommand("omnicopilot.manage");
    }
  }
}

export function deactivate(): void {
  for (const d of providerDisposables) {
    d.dispose();
  }
  providerDisposables = [];
  activeProviders = [];
  statusBar = undefined;
  panel = undefined;
}
