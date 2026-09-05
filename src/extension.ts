import * as vscode from "vscode";
import { OmniRouteError, formatErrorValue, serverRootUrl } from "./client";
import { configureCliTool } from "./cliBridge";
import { OmniPanelProvider } from "./panel";
import { OmniRouteChatProvider } from "./provider";
import { SECRET_PREFIX, cachedLoadRoutes, invalidateRouteCache, getClientForRoute } from "./routes";
import { ConnectionStatusBar } from "./statusBar";
import { MetricsTracker } from "./metrics";
import type { ResolvedChatUsage } from "./usage";
import { OmniStatusPopup } from "./statusPopup";
import { registerFixedTools, clearToolDiscoveryCache } from "./tools";

const OMNIROUTE_REPO = "https://github.com/diegosouzapw/OmniRoute";
const VENDOR = "omniroute-dev";

let activeProviders: OmniRouteChatProvider[] = [];
let providerDisposables: vscode.Disposable[] = [];
let statusBar: ConnectionStatusBar | undefined;
let panel: OmniPanelProvider | undefined;
let metricsTracker: MetricsTracker | undefined;
let syncPromise: Promise<void> = Promise.resolve();

function getConfig() {
  return vscode.workspace.getConfiguration("omnicopilot-dev");
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
    log.error(`Failed to sync providers: ${formatErrorValue(err)}`);
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

  const routes = await cachedLoadRoutes(context);
  const activeRoutes = routes.slice(0, 10);
  await vscode.commands.executeCommand("setContext", "omnicopilot-dev.routeCount", activeRoutes.length);
  const droppedRoutes = routes.slice(10);
  if (droppedRoutes.length > 0) {
    const names = droppedRoutes.map((r) => r.name.trim() || r.id).join(", ");
    log.warn(
      `OmniRoute supports up to 10 active servers simultaneously. Truncating ${routes.length} configured servers to 10. Not imported: ${names}.`
    );
  }

  const deps = {
    context,
    log,
    onActivity: (ok: boolean, routeId?: string) => statusBar?.reportActivity(ok, routeId),
    onUsage: (usage: ResolvedChatUsage) => statusBar?.reportUsage(usage),
    onRequestStart: (routeId: string | undefined, modelName: string) =>
      statusBar?.reportRequestStart(routeId, modelName),
    onRequestEnd: (ok: boolean, error: string | undefined, fallbacksUsed: number) =>
      statusBar?.reportRequestEnd(ok, error, fallbacksUsed),
    getOnlineRouteIds: () => statusBar?.onlineRouteIds(),
    onStall: (routeId: string) => {
      const route = activeRoutes.find((r) => r.id === routeId);
      if (route && metricsTracker) {
        void metricsTracker.recordStall(routeId, route.name, route.baseUrl);
      }
    },
  };

  if (activeRoutes.length <= 1) {
    const p = new OmniRouteChatProvider(deps);
    try {
      const reg = vscode.lm.registerLanguageModelChatProvider(VENDOR, p as unknown as vscode.LanguageModelChatProvider);
      activeProviders.push(p);
      providerDisposables.push(p, reg);
      log.info(`Registered provider for vendor "${VENDOR}" (${activeRoutes.length} server(s) configured)`);
    } catch (err) {
      log.error(`Failed to register chat provider for vendor "${VENDOR}": ${formatErrorValue(err)}`);
    }
  } else {
    // Stable vendor slots: the vendor id is part of the model identity VS Code
    // persists for the picker selection. Index-based assignment broke the
    // selected model whenever routes were reordered. Persist routeId→slot so
    // reorders are no-ops; only genuinely new routes take a free slot.
    const slots = loadVendorSlots(context);
    const slotByRoute = assignVendorSlots(activeRoutes, slots);
    saveVendorSlots(context, slotByRoute).catch((err) => {
      log.warn(`Could not persist vendor slots: ${formatErrorValue(err)}`);
    });
    for (const route of activeRoutes) {
      const slot = slotByRoute.get(route.id) ?? 0;
      const vendorId = slot === 0 ? VENDOR : `omniroute-dev-${slot + 1}`;
      const p = new OmniRouteChatProvider(deps, route.id);
      try {
        const reg = vscode.lm.registerLanguageModelChatProvider(vendorId, p as unknown as vscode.LanguageModelChatProvider);
        activeProviders.push(p);
        providerDisposables.push(p, reg);
        log.info(`Registered provider for server "${route.name}" under vendor slot "${vendorId}" (routeId: ${route.id})`);
      } catch (err) {
        log.error(`Failed to register chat provider for vendor "${vendorId}" (server: ${route.name}): ${formatErrorValue(err)}`);
      }
    }
  }
}

/** Persisted routeId → vendor slot (0-9). Kept in globalState so picker
 * selections survive reorders and restarts. Pure helpers, unit-testable. */
export const VENDOR_SLOTS_KEY = "omnicopilot-dev.vendorSlots.v1";
export const MAX_VENDOR_SLOTS = 10;

export function loadVendorSlots(context: vscode.ExtensionContext): Map<string, number> {
  const raw = context.globalState.get<unknown>(VENDOR_SLOTS_KEY, {});
  const out = new Map<string, number>();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [routeId, slot] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof slot === "number" && Number.isInteger(slot) && slot >= 0 && slot < MAX_VENDOR_SLOTS) {
        out.set(routeId, slot);
      }
    }
  }
  return out;
}

export function assignVendorSlots(
  routes: ReadonlyArray<{ id: string }>,
  stored: ReadonlyMap<string, number>
): Map<string, number> {
  const taken = new Set<number>();
  const assigned = new Map<string, number>();
  // Keep existing assignments for routes that are still configured.
  for (const route of routes) {
    const slot = stored.get(route.id);
    if (slot !== undefined && !taken.has(slot)) {
      taken.add(slot);
      assigned.set(route.id, slot);
    }
  }
  // New routes take the lowest free slot, in config order.
  for (const route of routes) {
    if (assigned.has(route.id)) continue;
    for (let slot = 0; slot < MAX_VENDOR_SLOTS; slot++) {
      if (!taken.has(slot)) {
        taken.add(slot);
        assigned.set(route.id, slot);
        break;
      }
    }
  }
  return assigned;
}

async function saveVendorSlots(
  context: vscode.ExtensionContext,
  slots: ReadonlyMap<string, number>
): Promise<void> {
  await context.globalState.update(VENDOR_SLOTS_KEY, Object.fromEntries(slots));
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("OmniCopilot", { log: true });
  context.subscriptions.push(log);
  log.info(`Activating v${context.extension.packageJSON.version}`);

  OmniRouteChatProvider.loadPersistentCache(context);

  metricsTracker = new MetricsTracker(context);
  context.subscriptions.push(metricsTracker);

  registerFixedTools(context, log);

  statusBar = new ConnectionStatusBar(
    async () => {
      return cachedLoadRoutes(context);
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
      if (!e.affectsConfiguration("omnicopilot-dev")) return;
      log.info("Configuration changed — refreshing models and status");
      // Only reset cooldowns when route-related config changes; other
      // settings (fallbackMode, modelFilter, maxTools) must not clear
      // per-server cooldowns that protect against 429/408 floods.
      const routeChanged =
        e.affectsConfiguration("omnicopilot-dev.routes") ||
        e.affectsConfiguration("omnicopilot-dev.baseUrl") ||
        e.affectsConfiguration("omnicopilot-dev.apiKey");
      invalidateRouteCache(!routeChanged);
      // Tool candidate discovery caches clients/routes; stale entries would
      // keep serving requests through a removed/edited server for 60s.
      clearToolDiscoveryCache();
      statusBar?.restart();
      void syncProviders(context, log).then(() => refreshAll());
      void panel?.refreshStatus();
    })
  );

  statusBar.start();
  void checkFirstRun(context, log);
}

/** Explain once why `dashboardOpen: "editor"` fell back to the browser. The flag
 * is compiled into the OmniRoute build, so this cannot be fixed from the client. */
let embedWarningShown = false;
async function warnDashboardNotEmbeddable(): Promise<void> {
  if (embedWarningShown) return;
  embedWarningShown = true;
  const learnMore = vscode.l10n.t("How to enable it");
  const pick = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      "This OmniRoute server does not allow embedding, so the dashboard opened in your browser. It has to be built with DASHBOARD_ALLOW_EMBED=vscode — a build-time option, so setting the variable on an existing install is not enough."
    ),
    learnMore
  );
  if (pick === learnMore) {
    void vscode.env.openExternal(
      vscode.Uri.parse("https://github.com/diegosouzapw/OmniRoute/blob/main/docs/guides/VSCODE-COPILOT.md")
    );
  }
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
  register("omnicopilot-dev.manage", () => panel?.focus());
  register("omnicopilot-dev.openSettings", async () =>
    vscode.commands.executeCommand("workbench.action.openSettings", "omnicopilot-dev")
  );
  register("omnicopilot-dev.setApiKey", () => setApiKey(context, log));

  register("omnicopilot-dev.refreshModels", async () => {
    await onRefresh();
    const routes = await cachedLoadRoutes(context);
    if (activeProviders.length > 0) {
      const cts = new vscode.CancellationTokenSource();
      // Re-list every server: in multi-vendor mode each provider is scoped to
      // one route, so counting only providers[0] would under-report model(s).
      const models = (
        await Promise.all(
          activeProviders.map((p) => p.provideLanguageModelChatInformation({ silent: true }, cts.token))
        )
      ).flat();
      await cts.dispose();
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Models synced: {0} model(s) found across {1} server(s).", models.length, routes.length)
      );
    } else {
      void vscode.window.showInformationMessage(vscode.l10n.t("Model list updated."));
    }
  });

  register("omnicopilot-dev.checkConnection", async () => {
    const ok = await statusBar?.checkNow();
    if (ok) {
      const routes = await cachedLoadRoutes(context);
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Connected to OmniRoute at {0}.", routes[0]?.baseUrl ?? "")
      );
    } else {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          "OmniRoute is unreachable. Check that it is running (npx omniroute) and that omnicopilot-dev.routes is configured."
        )
      );
    }
  });

  register("omnicopilot-dev.openDashboard", async () => {
    const routes = await cachedLoadRoutes(context);
    if (routes.length === 0) return;
    let targetRoute = routes[0];
    if (routes.length > 1) {
      const picked = await vscode.window.showQuickPick(
        routes.map((r) => ({
          label: r.name,
          description: serverRootUrl(r.baseUrl),
          route: r,
        })),
        { title: vscode.l10n.t("OmniRoute: open dashboard") }
      );
      if (!picked) return;
      targetRoute = picked.route;
    }
    const root = serverRootUrl(targetRoute.baseUrl);
    const mode = getConfig().get<string>("dashboardOpen", "external");
    if (mode === "editor") {
      // The Simple Browser is an iframe, so the server must allow framing.
      // Probing first matters: simpleBrowser.show SUCCEEDS against a server that
      // sends X-Frame-Options: DENY, leaving a "refused to connect" tab that the
      // catch below would never see.
      const client = getClientForRoute(targetRoute, log);
      if (await client.canEmbedDashboard()) {
        try {
          await vscode.commands.executeCommand("simpleBrowser.show", root);
          return;
        } catch (err) {
          log.warn(`Simple Browser unavailable, falling back to external: ${formatErrorValue(err)}`);
        }
      } else {
        log.info(
          `${root} does not allow framing — opening externally. Rebuild OmniRoute with DASHBOARD_ALLOW_EMBED=vscode to enable the editor tab.`
        );
        void warnDashboardNotEmbeddable();
      }
    }
    void vscode.env.openExternal(vscode.Uri.parse(root));
  });

  register("omnicopilot-dev.openGitHub", () => {
    void vscode.env.openExternal(vscode.Uri.parse(OMNIROUTE_REPO));
  });

  register("omnicopilot-dev.installOmniRoute", async () => {
    const copyLabel = vscode.l10n.t("Copy install command");
    const githubLabel = vscode.l10n.t("Open GitHub");
    const pick = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        "OmniRoute is a free, open-source AI router: one endpoint, 340+ providers (90+ free), auto-fallback. Install it with npm and this extension lights up automatically."
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

  register("omnicopilot-dev.configureCliTool", (toolId?: unknown) =>
    configureCliTool(context, log, typeof toolId === "string" ? toolId : undefined)
  );

  register("omnicopilot-dev.showStatusPopup", () => {
    if (metricsTracker && statusBar) {
      OmniStatusPopup.show(context, metricsTracker, log, statusBar);
    }
  });

  register("omnicopilot-dev.quickActions", () => {
    if (metricsTracker && statusBar) {
      OmniStatusPopup.show(context, metricsTracker, log, statusBar);
    } else {
      void quickActions(context, log);
    }
  });

  register("omnicopilot-dev.copyDiagnostics", async () => {
    const text = await buildDiagnostics(context, log);
    await vscode.env.clipboard.writeText(text);
    void vscode.window.showInformationMessage(
      vscode.l10n.t("Diagnostics copied — paste them into your issue or chat.")
    );
  });
}

/** One-shot diagnostic bundle for issues and support chats. Never includes
 * API keys — only route names/URLs, settings, token totals and the last
 * request outcome. */
export async function buildDiagnostics(
  context: vscode.ExtensionContext,
  log?: vscode.LogOutputChannel
): Promise<string> {
  const cfg = getConfig();
  const version = (context.extension.packageJSON as { version?: string }).version ?? "?";
  const routes = await cachedLoadRoutes(context).catch(() => []);
  const online = statusBar && routes.length > 0
    ? await Promise.all(routes.map((r) => getClientForRoute(r, log).ping(4000)))
    : [];
  const lines = [
    "OmniCopilot diagnostics",
    `- Extension: v${version}`,
    routes.length === 0
      ? "- Routes: none configured"
      : `- Routes: ${routes.map((r, i) => `${r.name} (${online[i] ? "online" : "unreachable"})`).join(", ")}`,
    `- Settings: transport=${cfg.get<string>("transport", "auto")}, ` +
    `fallbackMode=${cfg.get<string>("fallbackMode", "sameModel")}, ` +
    `maxTools=${cfg.get<number>("maxTools", 32)}, ` +
    `maxOutputTokens=${cfg.get<number>("maxOutputTokens", 8192)}`,
  ];
  const metrics = metricsTracker?.getMetrics();
  if (metrics) {
    const cached = metrics.totalCachedTokens ?? 0;
    lines.push(
      `- Session: ${metrics.totalRequests} requests, ` +
      `in=${fmtSessionTokens(metrics.totalInputTokens)} / out=${fmtSessionTokens(metrics.totalOutputTokens)} / cached=${fmtSessionTokens(cached)}`
    );
    const spends = Object.values(metrics.models ?? {});
    spends.sort((a, b) => b.totalTokens - a.totalTokens);
    const top = spends[0];
    if (top && top.totalTokens > 0) {
      lines.push(`- Top model: ${top.modelName} (${fmtSessionTokens(top.totalTokens)} tokens, ${top.requestCount} requests)`);
    }
  }
  const snap = statusBar?.getSnapshot();
  if (snap?.usage) {
    lines.push(
      `- Last request: ${snap.usage.modelName} @ ${snap.usage.serverName} ` +
      `(in=${snap.usage.inputTokens} / out=${snap.usage.outputTokens}, fallbacks=${snap.fallbackCount})`
    );
  }
  if (snap?.lastError) lines.push(`- Last error: ${snap.lastError}`);
  return lines.join("\n");
}

function fmtSessionTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}


/** Explain once why `dashboardOpen: "editor"` fell back to the browser. The flag
 * is compiled into the OmniRoute build, so this cannot be fixed from the client. */
/** Menu behind the status-bar item. */
async function quickActions(context: vscode.ExtensionContext, log?: vscode.LogOutputChannel): Promise<void> {
  const routes = await cachedLoadRoutes(context);
  const results = await Promise.all(routes.map((r) => getClientForRoute(r, log).ping(4000)));
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

  const picked = await vscode.window.showQuickPick(items, { title: "OmniCopilot" });
  const commandByAction: Record<string, string> = {
    check: "omnicopilot-dev.checkConnection",
    manage: "omnicopilot-dev.manage",
    refresh: "omnicopilot-dev.refreshModels",
    dashboard: "omnicopilot-dev.openDashboard",
    cli: "omnicopilot-dev.configureCliTool",
    github: "omnicopilot-dev.openGitHub",
    install: "omnicopilot-dev.installOmniRoute",
  };
  if (picked) void vscode.commands.executeCommand(commandByAction[picked.action]);
}

async function setApiKey(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  optionalFlow = false
): Promise<void> {
  const routes = await cachedLoadRoutes(context);
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

/** One-time welcome: stepped setup (connectivity → auth → model suggestion)
 * instead of a single generic message, so a fresh install lands working. */
async function checkFirstRun(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel
): Promise<void> {
  const FLAG = "omnicopilot-dev.welcomed";
  if (context.globalState.get<boolean>(FLAG)) return;
  await context.globalState.update(FLAG, true);
  try {
    await runSetupWizard(context, log);
  } catch (err) {
    log.warn(`Setup wizard failed (non-fatal): ${formatErrorValue(err)}`);
  }
}

/** Step 1 (connectivity) + Step 2 (auth) + Step 3 (model suggestion). Every
 * step degrades to the next message instead of throwing: the wizard must
 * never break activation. */
export async function runSetupWizard(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel
): Promise<void> {
  const routes = await cachedLoadRoutes(context);
  if (routes.length === 0) {
    return showOfflineWelcome();
  }
  const pings = await Promise.all(routes.map((r) => getClientForRoute(r, log).ping(5000)));
  const onlineRoutes = routes.filter((_, i) => pings[i]);
  log.info(`First run — ${onlineRoutes.length}/${routes.length} route(s) online`);
  if (onlineRoutes.length === 0) {
    return showOfflineWelcome();
  }

  // Step 2: auth — a 401/403 here means the key is wrong; offer the fix now
  // instead of letting the user discover it on the first chat message.
  for (const route of onlineRoutes) {
    try {
      await getClientForRoute(route, log).listModels();
    } catch (err) {
      if (err instanceof OmniRouteError && (err.status === 401 || err.status === 403)) {
        log.warn(`Setup wizard: route "${route.name}" rejected its API key (HTTP ${err.status})`);
        const fixLabel = vscode.l10n.t("Set API key");
        const pick = await vscode.window.showWarningMessage(
          vscode.l10n.t('Server "{0}" is online but rejected its API key. Set it now to light up your models.', route.name),
          fixLabel
        );
        if (pick === fixLabel) {
          await setApiKey(context, log, true);
          await refreshAll();
        }
        return;
      }
      log.warn(`Setup wizard: model probe on "${route.name}" failed: ${formatErrorValue(err)}`);
    }
  }

  // Step 3: suggest concrete models so the 1200-entry picker is not a wall.
  const suggestion = await suggestStarterModels(onlineRoutes, log);
  const where = onlineRoutes.map((r) => r.name).join(", ");
  const pick = await vscode.window.showInformationMessage(
    suggestion
      ? vscode.l10n.t(
          "OmniRoute ready on {0}. Suggested: {1} for Agent mode, {2} for long context — open the Copilot Chat model picker to choose.",
          where, suggestion.agent, suggestion.longContext
        )
      : vscode.l10n.t(
          "OmniRoute detected! Your models are ready — open the Copilot Chat model picker and choose any OmniRoute model."
        ),
    vscode.l10n.t("How to pick a model")
  );
  if (pick) {
    void vscode.env.openExternal(
      vscode.Uri.parse("https://code.visualstudio.com/docs/agent-customization/language-models")
    );
  }
}

/** Cheapest guidance without pricing data: the largest-context tool-capable
 * model for Agent mode, and the largest context overall for long documents. */
async function suggestStarterModels(
  routes: Array<{ id: string; name: string; baseUrl: string; apiKey?: string }>,
  log: vscode.LogOutputChannel
): Promise<{ agent: string; longContext: string } | undefined> {
  const seen = new Map<string, { id: string; context: number; tools: boolean }>();
  for (const route of routes) {
    let models: Array<{
      id?: string; context_length?: number; capabilities?: { tool_calling?: boolean };
    }> = [];
    try {
      models = await getClientForRoute(route, log).listModels();
    } catch {
      continue;
    }
    for (const m of models) {
      if (!m?.id || seen.has(m.id)) continue;
      seen.set(m.id, {
        id: m.id,
        context: typeof m.context_length === "number" && m.context_length > 0 ? m.context_length : 0,
        tools: m.capabilities?.tool_calling === true,
      });
    }
  }
  const all = [...seen.values()].filter((m) => m.context > 0);
  if (all.length === 0) return undefined;
  const byContext = [...all].sort((a, b) => b.context - a.context);
  const agent = byContext.find((m) => m.tools) ?? byContext[0];
  return { agent: agent.id, longContext: byContext[0].id };
}

async function showOfflineWelcome(): Promise<void> {
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
    void vscode.commands.executeCommand("omnicopilot-dev.installOmniRoute");
  } else if (pick === configureLabel) {
    void vscode.commands.executeCommand("omnicopilot-dev.manage");
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
