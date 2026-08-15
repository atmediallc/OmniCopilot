import * as vscode from "vscode";
import type { MetricsTracker } from "./metrics";
import { fmtTokens } from "./metrics";
import { loadRoutes, makeClientForRoute } from "./routes";

export class OmniStatusPopup {
  private static currentPanel: vscode.WebviewPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private autoRefreshTimer: NodeJS.Timeout | undefined;
  private isUpdating = false;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly metricsTracker: MetricsTracker,
    private readonly log: vscode.LogOutputChannel
  ) {
    this.panel = panel;
    this.log.info("OmniStatusPopup webview panel created.");

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Listen for real-time metrics changes from MetricsTracker
    this.disposables.push(
      this.metricsTracker.onDidChangeMetrics(() => {
        void this.updateStateData();
      })
    );

    // Auto-refresh ping & latency every 3 seconds
    this.autoRefreshTimer = setInterval(() => {
      void this.updateStateData();
    }, 3000);

    this.panel.webview.onDidReceiveMessage(
      async (msg: { command: string; value?: unknown }) => {
        switch (msg.command) {
          case "ready":
          case "refresh":
            await this.updateStateData();
            break;
          case "resetMetrics":
            await this.metricsTracker.resetMetrics();
            await this.updateStateData();
            void vscode.window.showInformationMessage(
              vscode.l10n.t("Token metrics reset.")
            );
            break;
          case "toggleSetting": {
            const payload = msg.value as { setting: string; enabled: boolean };
            await vscode.workspace
              .getConfiguration("omnicopilot")
              .update(payload.setting, payload.enabled, vscode.ConfigurationTarget.Global);
            await this.updateStateData();
            break;
          }
          case "changeFallbackMode": {
            const mode = msg.value as string;
            await vscode.workspace
              .getConfiguration("omnicopilot")
              .update("fallbackMode", mode, vscode.ConfigurationTarget.Global);
            await this.updateStateData();
            break;
          }
          case "runCommand": {
            const payload = msg.value as { cmd: string; args?: unknown[] };
            if (payload.args && payload.args.length > 0) {
              await vscode.commands.executeCommand(payload.cmd, ...payload.args);
            } else {
              await vscode.commands.executeCommand(payload.cmd);
            }
            break;
          }
          case "snooze": {
            void vscode.window.showInformationMessage(
              vscode.l10n.t("Status bar metrics snoozed for 5 minutes.")
            );
            break;
          }
        }
      },
      null,
      this.disposables
    );

    this.panel.webview.html = this.getHtmlForWebview();
  }

  public static show(
    context: vscode.ExtensionContext,
    metricsTracker: MetricsTracker,
    log: vscode.LogOutputChannel
  ): void {
    if (OmniStatusPopup.currentPanel) {
      OmniStatusPopup.currentPanel.reveal(vscode.ViewColumn.Active);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "omniRouteStatusPopup",
      vscode.l10n.t("OmniRoute — Status & Metrics"),
      {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: false,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [context.extensionUri],
      }
    );

    OmniStatusPopup.currentPanel = panel;
    new OmniStatusPopup(panel, context, metricsTracker, log);
  }

  public dispose(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = undefined;
    }
    OmniStatusPopup.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }

  private lastUpdateMs = 0;

  private async updateStateData(): Promise<void> {
    const now = Date.now();
    if (this.isUpdating || now - this.lastUpdateMs < 1000) return;
    this.isUpdating = true;
    this.lastUpdateMs = now;
    try {
      const routes = await loadRoutes(this.context);
      const metrics = this.metricsTracker.getMetrics(routes);
      const cfg = vscode.workspace.getConfiguration("omnicopilot");
      const fallbackMode = cfg.get<string>("fallbackMode", "sameModel");
      const statusBarEnabled = cfg.get<boolean>("statusBar", true);
      const retriesPerServer = cfg.get<number>("retriesPerServer", 1);

      const onlineRouteIds = new Set<string>();
      const serverDetails = await Promise.all(
        routes.map(async (r) => {
          const client = makeClientForRoute(r, this.log);
          const serverMetric = metrics.servers[r.id] || {
            routeId: r.id,
            name: r.name,
            baseUrl: r.baseUrl,
            online: false,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            requestCount: 0,
            successCount: 0,
            errorCount: 0,
          };

          const t0 = Date.now();
          const online = await client.ping(3000);
          const latencyMs = Date.now() - t0;

          if (online) onlineRouteIds.add(r.id);
          void this.metricsTracker.recordActivity(r.id, r.name, r.baseUrl, online);

          return {
            id: r.id,
            name: r.name,
            baseUrl: r.baseUrl,
            online,
            latencyMs,
            metric: {
              inputTokens: serverMetric.inputTokens,
              outputTokens: serverMetric.outputTokens,
              totalTokens: serverMetric.totalTokens,
              requestCount: serverMetric.requestCount,
              successCount: serverMetric.successCount,
              errorCount: serverMetric.errorCount,
              lastUsedModel: serverMetric.lastUsedModel,
            },
          };
        })
      );

      const suggestions = this.metricsTracker.generateSuggestions(routes, onlineRouteIds);

      await this.panel.webview.postMessage({
        command: "updateState",
        state: {
          metrics: {
            totalInputTokens: metrics.totalInputTokens,
            totalOutputTokens: metrics.totalOutputTokens,
            totalTokens: metrics.totalTokens,
            totalRequests: metrics.totalRequests,
            formattedTotalTokens: fmtTokens(metrics.totalTokens),
            formattedOutputTokens: fmtTokens(metrics.totalOutputTokens),
          },
          servers: serverDetails,
          suggestions,
          fallbackMode,
          statusBarEnabled,
          retriesPerServer,
        },
      });
    } catch (err) {
      this.log.error(`Error updating status popup state: ${String(err)}`);
    } finally {
      this.isUpdating = false;
    }
  }

  private getHtmlForWebview(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: https:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OmniRoute Status & Metrics</title>
  <style>
    :root {
      --bg: var(--vscode-sideBar-background, #1e1e1e);
      --card-bg: var(--vscode-editor-background, #252526);
      --fg: var(--vscode-editor-foreground, #cccccc);
      --border: var(--vscode-panel-border, #3c3c3c);
      --accent: var(--vscode-button-background, #0e639c);
      --accent-hover: var(--vscode-button-hoverBackground, #1177bb);
      --success: #3fb950;
      --warning: #d29922;
      --danger: #f85149;
    }
    body {
      font-family: var(--vscode-font-family, system-ui, -apple-system, sans-serif);
      font-size: 13px;
      color: var(--fg);
      background-color: var(--bg);
      margin: 0;
      padding: 16px;
      line-height: 1.5;
    }
    .popup-container {
      max-width: 650px;
      margin: 0 auto;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 16px;
    }
    .header-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 16px;
      font-weight: 600;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      display: inline-block;
      transition: background-color 0.3s ease;
    }
    .dot-online { background-color: var(--success); box-shadow: 0 0 6px var(--success); }
    .dot-partial { background-color: var(--warning); box-shadow: 0 0 6px var(--warning); }
    .dot-offline { background-color: var(--danger); }

    .badge {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 10px;
      font-weight: 500;
    }
    .badge-success { background: rgba(63, 185, 80, 0.15); color: var(--success); }
    .badge-danger { background: rgba(248, 81, 73, 0.15); color: var(--danger); }
    .badge-impact-high, .badge-impact-alta { background: rgba(248, 81, 73, 0.2); color: #ff7b72; }
    .badge-impact-medium, .badge-impact-media { background: rgba(210, 153, 34, 0.2); color: #e3b341; }
    .badge-impact-low, .badge-impact-baja { background: rgba(56, 139, 253, 0.2); color: #58a6ff; }

    .header-actions {
      display: flex;
      gap: 8px;
    }
    .btn {
      background-color: var(--accent);
      color: #ffffff;
      border: none;
      padding: 5px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn:hover { background-color: var(--accent-hover); }
    .btn-secondary {
      background-color: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ffffff);
    }
    .btn-secondary:hover {
      background-color: var(--vscode-button-secondaryHoverBackground, #45494e);
    }
    .btn-sm { padding: 3px 8px; font-size: 11px; }

    .section {
      background-color: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 14px;
      margin-bottom: 16px;
    }
    .section-title {
      font-weight: 600;
      font-size: 13px;
      margin-top: 0;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    /* Metric progress bars */
    .metric-group {
      margin-bottom: 12px;
    }
    .metric-label-row {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      margin-bottom: 4px;
    }
    .progress-bar-bg {
      height: 8px;
      background-color: var(--border);
      border-radius: 4px;
      overflow: hidden;
    }
    .progress-bar-fill {
      height: 100%;
      background: linear-gradient(90deg, #0e639c, #3fb950);
      border-radius: 4px;
      transition: width 0.3s ease;
    }

    /* Server cards list */
    .server-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .server-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 10px 12px;
    }
    .server-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .server-title {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .server-url {
      font-size: 11px;
      opacity: 0.7;
    }
    .server-stats {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
      font-size: 12px;
    }
    .stat-item {
      display: flex;
      flex-direction: column;
    }
    .stat-label { font-size: 10px; opacity: 0.65; }
    .stat-value { font-weight: 600; }
    .stat-value.highlight { color: #58a6ff; }
    .server-footer {
      font-size: 11px;
      opacity: 0.8;
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px dashed var(--border);
    }

    /* Toggle items */
    .toggle-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .toggle-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .toggle-label {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
    }
    select {
      background: var(--vscode-dropdown-background, #3c3c3c);
      color: var(--vscode-dropdown-foreground, #ffffff);
      border: 1px solid var(--border);
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
    }

    /* Suggestions */
    .suggestions-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .suggestion-card {
      border: 1px solid var(--border);
      border-left: 4px solid var(--accent);
      border-radius: 4px;
      padding: 10px 12px;
      background: rgba(255, 255, 255, 0.02);
    }
    .suggestion-optimization { border-left-color: #58a6ff; }
    .suggestion-redundancy { border-left-color: #d29922; }
    .suggestion-health { border-left-color: #f85149; }
    .suggestion-capability { border-left-color: #a371f7; }
    .suggestion-info { border-left-color: #3fb950; }

    .suggestion-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 4px;
    }
    .suggestion-icon { font-size: 14px; }
    .suggestion-body {
      font-size: 12px;
      opacity: 0.85;
      margin-bottom: 8px;
    }

    .footer-links {
      display: flex;
      justify-content: space-between;
      margin-top: 16px;
      font-size: 12px;
    }
    .footer-links a {
      color: #58a6ff;
      text-decoration: none;
      cursor: pointer;
    }
    .footer-links a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="popup-container">
    <!-- Header -->
    <div class="header">
      <div class="header-title">
        <span id="header-dot" class="dot dot-offline"></span>
        <span>OmniRoute</span>
        <span id="header-badge" class="badge badge-danger">Loading...</span>
      </div>
      <div class="header-actions">
        <button class="btn btn-secondary btn-sm" onclick="runCommand('omnicopilot.openDashboard')">📊 Dashboard</button>
        <button class="btn btn-secondary btn-sm" onclick="runCommand('omnicopilot.manage')">⚙ Configure</button>
        <button class="btn btn-secondary btn-sm" onclick="sendMessage('refresh')">🔄 Refresh</button>
      </div>
    </div>

    <!-- Token Metrics Section -->
    <div class="section">
      <div class="section-title">
        <span>Token Consumption & Server Metrics</span>
        <button class="btn btn-secondary btn-sm" onclick="sendMessage('resetMetrics')">Reset Metrics</button>
      </div>

      <div class="metric-group">
        <div class="metric-label-row">
          <span>Total Tokens Consumed (Session)</span>
          <strong id="total-tokens-text">0 tokens (0 reqs)</strong>
        </div>
        <div class="progress-bar-bg">
          <div id="total-tokens-bar" class="progress-bar-fill" style="width: 0%"></div>
        </div>
      </div>

      <div class="metric-group">
        <div class="metric-label-row">
          <span>Output Tokens</span>
          <strong id="output-tokens-text">0 tokens (0% of total)</strong>
        </div>
        <div class="progress-bar-bg">
          <div id="output-tokens-bar" class="progress-bar-fill" style="width: 0%; background: linear-gradient(90deg, #a371f7, #58a6ff);"></div>
        </div>
      </div>

      <div style="margin-top: 14px;">
        <div style="font-weight: 500; margin-bottom: 8px;">Connected Servers (<span id="server-count">0</span>)</div>
        <div id="server-list" class="server-list">
          <div style="opacity:0.6; font-style:italic">Loading servers...</div>
        </div>
      </div>
    </div>

    <!-- Quick Settings & Options -->
    <div class="section">
      <div class="section-title">
        <span>OmniRoute Quick Settings</span>
        <button class="btn btn-secondary btn-sm" onclick="sendMessage('snooze')">Snooze (5m)</button>
      </div>

      <div class="toggle-list">
        <div class="toggle-item">
          <label class="toggle-label">
            <input type="checkbox" id="status-bar-toggle" onchange="toggleSetting('statusBar', this.checked)">
            <span>Show token consumption in status bar</span>
          </label>
        </div>

        <div class="toggle-item">
          <span>Fallback Strategy:</span>
          <select id="fallback-select" onchange="changeFallbackMode(this.value)">
            <option value="sameModel">Same Model (Recommended)</option>
            <option value="sameFamily">Same Model Family</option>
            <option value="full">Full Fallback</option>
            <option value="none">Disabled (No Fallback)</option>
          </select>
        </div>

        <div class="toggle-item">
          <span>Retries per server:</span>
          <span id="retries-text" style="opacity:0.8; font-weight:500;">1 retry(ies) per server</span>
        </div>

        <div class="toggle-item">
          <span>Model Catalog Sync:</span>
          <button class="btn btn-secondary btn-sm" onclick="runCommand('omnicopilot.refreshModels')">🔄 Sync Models</button>
        </div>
      </div>
    </div>

    <!-- Smart Suggestions & Improvement Recommendations -->
    <div class="section">
      <div class="section-title">
        <span>Improvement & Optimization Suggestions</span>
        <span id="suggestions-count" style="font-size:11px; opacity:0.6">0 recommendations</span>
      </div>
      <div id="suggestions-list" class="suggestions-list">
      </div>
    </div>

    <!-- Footer Links -->
    <div class="footer-links">
      <a onclick="runCommand('omnicopilot.configureCliTool')">⚡ Configure CLI Bridge (Aider/Claude)</a>
      <a onclick="runCommand('omnicopilot.checkConnection')">🩺 Check Server Health</a>
      <a onclick="runCommand('omnicopilot.openGitHub')">⭐ OmniRoute on GitHub</a>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    function sendMessage(command, value) {
      vscode.postMessage({ command, value });
    }

    function runCommand(cmd, args) {
      vscode.postMessage({ command: 'runCommand', value: { cmd, args } });
    }

    function toggleSetting(setting, enabled) {
      vscode.postMessage({ command: 'toggleSetting', value: { setting, enabled } });
    }

    function changeFallbackMode(mode) {
      vscode.postMessage({ command: 'changeFallbackMode', value: mode });
    }

    function getSuggestionIcon(type) {
      switch (type) {
        case "optimization": return "💡";
        case "redundancy": return "🛡️";
        case "health": return "🚨";
        case "capability": return "⚡";
        default: return "ℹ️";
      }
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    function fmtTokens(n) {
      if (!n || n <= 0) return '0';
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return String(n);
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (!msg || msg.command !== 'updateState' || !msg.state) return;
      const state = msg.state;

      // Update Header Status
      const servers = state.servers || [];
      const onlineCount = servers.filter(s => s.online).length;
      const totalCount = servers.length;
      const isFullyOnline = totalCount > 0 && onlineCount === totalCount;
      const dotEl = document.getElementById('header-dot');
      const badgeEl = document.getElementById('header-badge');
      if (dotEl) {
        dotEl.className = 'dot ' + (isFullyOnline ? 'dot-online' : onlineCount > 0 ? 'dot-partial' : 'dot-offline');
      }
      if (badgeEl) {
        badgeEl.className = 'badge ' + (isFullyOnline ? 'badge-success' : 'badge-danger');
        badgeEl.textContent = totalCount === 0 ? 'No servers' : (onlineCount + '/' + totalCount + ' connected');
      }

      // Update Token Progress Bars
      const metrics = state.metrics || {};
      const totalTokensText = document.getElementById('total-tokens-text');
      const totalTokensBar = document.getElementById('total-tokens-bar');
      const outputTokensText = document.getElementById('output-tokens-text');
      const outputTokensBar = document.getElementById('output-tokens-bar');

      const maxReferenceTokens = 500000;
      const totalPct = Math.min(Math.round(((metrics.totalTokens || 0) / maxReferenceTokens) * 100), 100);
      const outputPct = Math.min(Math.round(((metrics.totalOutputTokens || 0) / Math.max(metrics.totalTokens || 1, 1)) * 100), 100);

      if (totalTokensText) {
        totalTokensText.textContent = (metrics.formattedTotalTokens || '0') + ' tokens (' + (metrics.totalRequests || 0) + ' reqs)';
      }
      if (totalTokensBar) {
        totalTokensBar.style.width = totalPct + '%';
      }
      if (outputTokensText) {
        outputTokensText.textContent = (metrics.formattedOutputTokens || '0') + ' tokens (' + outputPct + '% of total)';
      }
      if (outputTokensBar) {
        outputTokensBar.style.width = outputPct + '%';
      }

      // Update Server List
      const serverCountEl = document.getElementById('server-count');
      const serverListEl = document.getElementById('server-list');
      if (serverCountEl) serverCountEl.textContent = String(totalCount);
      if (serverListEl) {
        if (servers.length === 0) {
          serverListEl.innerHTML = '<div style="opacity:0.6; font-style:italic">No servers configured.</div>';
        } else {
          serverListEl.innerHTML = servers.map(s => \`
            <div class="server-card">
              <div class="server-header">
                <div class="server-title">
                  <span class="dot \${s.online ? "dot-online" : "dot-offline"}"></span>
                  <strong>\${escapeHtml(s.name)}</strong>
                  <span class="badge \${s.online ? "badge-success" : "badge-danger"}">
                    \${s.online ? s.latencyMs + "ms" : "Offline"}
                  </span>
                </div>
                <span class="server-url">\${escapeHtml(s.baseUrl)}</span>
              </div>
              <div class="server-stats">
                <div class="stat-item">
                  <span class="stat-label">Input Tokens</span>
                  <span class="stat-value">\${fmtTokens(s.metric.inputTokens)}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-label">Output Tokens</span>
                  <span class="stat-value">\${fmtTokens(s.metric.outputTokens)}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-label">Total Tokens</span>
                  <span class="stat-value highlight">\${fmtTokens(s.metric.totalTokens)}</span>
                </div>
                <div class="stat-item">
                  <span class="stat-label">Requests</span>
                  <span class="stat-value">\${s.metric.requestCount}</span>
                </div>
              </div>
              \${s.metric.lastUsedModel ? \`<div class="server-footer">Last model: <code>\${escapeHtml(s.metric.lastUsedModel)}</code></div>\` : ""}
            </div>
          \`).join("");
        }
      }

      // Update Settings & Toggles
      const toggleEl = document.getElementById('status-bar-toggle');
      const fallbackEl = document.getElementById('fallback-select');
      const retriesEl = document.getElementById('retries-text');
      if (toggleEl && typeof state.statusBarEnabled === 'boolean') {
        toggleEl.checked = state.statusBarEnabled;
      }
      if (fallbackEl && state.fallbackMode) {
        fallbackEl.value = state.fallbackMode;
      }
      if (retriesEl && typeof state.retriesPerServer === 'number') {
        retriesEl.textContent = state.retriesPerServer + ' retry(ies) per server';
      }

      // Update Suggestions
      const suggestions = state.suggestions || [];
      const suggCountEl = document.getElementById('suggestions-count');
      const suggListEl = document.getElementById('suggestions-list');
      if (suggCountEl) suggCountEl.textContent = suggestions.length + ' recommendations';
      if (suggListEl) {
        suggListEl.innerHTML = suggestions.map(s => \`
          <div class="suggestion-card suggestion-\${s.type}">
            <div class="suggestion-header">
              <span class="suggestion-icon">\${getSuggestionIcon(s.type)}</span>
              <strong>\${escapeHtml(s.title)}</strong>
              <span class="badge badge-impact-\${(s.impact || '').toLowerCase()}">Impact: \${escapeHtml(s.impact)}</span>
            </div>
            <div class="suggestion-body">\${escapeHtml(s.description)}</div>
            \${
              s.actionLabel
                ? \`<button class="btn btn-secondary btn-sm" onclick="runCommand('\${s.actionCommand}', \${JSON.stringify(s.actionArgs || [])})">\${escapeHtml(s.actionLabel)} →</button>\`
                : ""
            }
          </div>
        \`).join("");
      }
    });

    // Request initial data on ready
    sendMessage('ready');
  </script>
</body>
</html>`;
  }
}
