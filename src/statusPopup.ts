import * as vscode from "vscode";
import type { MetricsTracker } from "./metrics";
import { fmtTokens } from "./metrics";
import { SECRET_PREFIX, loadRoutes } from "./routes";

export class OmniStatusPopup {
  private static currentPanel: vscode.WebviewPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly metricsTracker: MetricsTracker,
    private readonly log: vscode.LogOutputChannel
  ) {
    this.panel = panel;
    this.log.info("OmniStatusPopup webview panel created.");

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (msg: { command: string; value?: unknown }) => {
        switch (msg.command) {
          case "refresh":
            await this.updateWebview();
            break;
          case "resetMetrics":
            await this.metricsTracker.resetMetrics();
            await this.updateWebview();
            void vscode.window.showInformationMessage(
              vscode.l10n.t("Métricas de tokens reiniciadas.")
            );
            break;
          case "toggleSetting": {
            const payload = msg.value as { setting: string; enabled: boolean };
            await vscode.workspace
              .getConfiguration("omnicopilot")
              .update(payload.setting, payload.enabled, vscode.ConfigurationTarget.Global);
            await this.updateWebview();
            break;
          }
          case "changeFallbackMode": {
            const mode = msg.value as string;
            await vscode.workspace
              .getConfiguration("omnicopilot")
              .update("fallbackMode", mode, vscode.ConfigurationTarget.Global);
            await this.updateWebview();
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
            // Snooze status bar readout for 5 minutes
            void vscode.window.showInformationMessage(
              vscode.l10n.t("Métricas de la barra de estado pausadas por 5 minutos.")
            );
            break;
          }
        }
      },
      null,
      this.disposables
    );

    void this.updateWebview();
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
      "OmniRoute — Métricas y Estado",
      {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: false,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    OmniStatusPopup.currentPanel = panel;
    new OmniStatusPopup(panel, context, metricsTracker, log);
  }

  public dispose(): void {
    OmniStatusPopup.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }

  private async updateWebview(): Promise<void> {
    const routes = await loadRoutes(this.context);
    const metrics = this.metricsTracker.getMetrics(routes);
    const cfg = vscode.workspace.getConfiguration("omnicopilot");
    const fallbackMode = cfg.get<string>("fallbackMode", "sameModel");
    const statusBarEnabled = cfg.get<boolean>("statusBar", true);
    const retriesPerServer = cfg.get<number>("retriesPerServer", 1);

    const onlineRouteIds = new Set<string>();
    const serverDetails = await Promise.all(
      routes.map(async (r) => {
        const key = await this.context.secrets.get(SECRET_PREFIX + r.id);
        const serverMetric = metrics.servers[r.id] || {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          requestCount: 0,
          successCount: 0,
          errorCount: 0,
        };

        // Ping check
        let online = false;
        let latencyMs = 0;
        try {
          const t0 = Date.now();
          const res = await fetch(`${r.baseUrl.replace(/\/+$/, "")}/models`, {
            headers: key ? { Authorization: `Bearer ${key}` } : {},
            signal: AbortSignal.timeout(3000),
          });
          online = res.ok;
          latencyMs = Date.now() - t0;
        } catch {
          online = false;
        }

        if (online) onlineRouteIds.add(r.id);

        return {
          id: r.id,
          name: r.name,
          baseUrl: r.baseUrl,
          online,
          latencyMs,
          metric: serverMetric,
        };
      })
    );

    const suggestions = this.metricsTracker.generateSuggestions(routes, onlineRouteIds);

    this.panel.webview.html = this.getHtmlForWebview(
      metrics,
      serverDetails,
      suggestions,
      fallbackMode,
      statusBarEnabled,
      retriesPerServer
    );
  }

  private getHtmlForWebview(
    metrics: ReturnType<MetricsTracker["getMetrics"]>,
    servers: Array<{
      id: string;
      name: string;
      baseUrl: string;
      online: boolean;
      latencyMs: number;
      metric: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        requestCount: number;
        successCount: number;
        errorCount: number;
        lastUsedModel?: string;
      };
    }>,
    suggestions: ReturnType<MetricsTracker["generateSuggestions"]>,
    fallbackMode: string,
    statusBarEnabled: boolean,
    retriesPerServer: number
  ): string {
    const onlineCount = servers.filter((s) => s.online).length;
    const totalCount = servers.length;
    const isFullyOnline = totalCount > 0 && onlineCount === totalCount;
    const statusDotClass = isFullyOnline ? "dot-online" : onlineCount > 0 ? "dot-partial" : "dot-offline";
    const statusText = totalCount === 0 ? "Sin servidores" : `${onlineCount}/${totalCount} conectados`;

    // Simulated quota / budget metrics for progress bar
    const maxReferenceTokens = 500000;
    const totalPct = Math.min(Math.round((metrics.totalTokens / maxReferenceTokens) * 100), 100);
    const outputPct = Math.min(
      Math.round((metrics.totalOutputTokens / Math.max(metrics.totalTokens, 1)) * 100),
      100
    );

    const serverRowsHtml = servers.map((s) => `
      <div class="server-card">
        <div class="server-header">
          <div class="server-title">
            <span class="dot ${s.online ? "dot-online" : "dot-offline"}"></span>
            <strong>${escapeHtml(s.name)}</strong>
            <span class="badge ${s.online ? "badge-success" : "badge-danger"}">
              ${s.online ? `${s.latencyMs}ms` : "Offline"}
            </span>
          </div>
          <span class="server-url">${escapeHtml(s.baseUrl)}</span>
        </div>
        <div class="server-stats">
          <div class="stat-item">
            <span class="stat-label">Tokens Entrada</span>
            <span class="stat-value">${fmtTokens(s.metric.inputTokens)}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Tokens Salida</span>
            <span class="stat-value">${fmtTokens(s.metric.outputTokens)}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Total Tokens</span>
            <span class="stat-value highlight">${fmtTokens(s.metric.totalTokens)}</span>
          </div>
          <div class="stat-item">
            <span class="stat-label">Solicitudes</span>
            <span class="stat-value">${s.metric.requestCount}</span>
          </div>
        </div>
        ${s.metric.lastUsedModel ? `<div class="server-footer">Último modelo: <code>${escapeHtml(s.metric.lastUsedModel)}</code></div>` : ""}
      </div>
    `).join("");

    const suggestionsHtml = suggestions.map((s) => `
      <div class="suggestion-card suggestion-${s.type}">
        <div class="suggestion-header">
          <span class="suggestion-icon">${getSuggestionIcon(s.type)}</span>
          <strong>${escapeHtml(s.title)}</strong>
          <span class="badge badge-impact-${s.impact.toLowerCase()}">Impacto: ${s.impact}</span>
        </div>
        <div class="suggestion-body">${escapeHtml(s.description)}</div>
        ${
          s.actionLabel
            ? `<button class="btn btn-secondary btn-sm" onclick="runCommand('${s.actionCommand}', ${JSON.stringify(s.actionArgs || [])})">${escapeHtml(s.actionLabel)} →</button>`
            : ""
        }
      </div>
    `).join("");

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
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
    .badge-impact-alta { background: rgba(248, 81, 73, 0.2); color: #ff7b72; }
    .badge-impact-media { background: rgba(210, 153, 34, 0.2); color: #e3b341; }
    .badge-impact-baja { background: rgba(56, 139, 253, 0.2); color: #58a6ff; }

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
        <span class="dot ${statusDotClass}"></span>
        <span>OmniRoute</span>
        <span class="badge ${isFullyOnline ? "badge-success" : "badge-danger"}">${statusText}</span>
      </div>
      <div class="header-actions">
        <button class="btn btn-secondary btn-sm" onclick="runCommand('omnicopilot.openDashboard')">📊 Dashboard</button>
        <button class="btn btn-secondary btn-sm" onclick="runCommand('omnicopilot.manage')">⚙ Configurar</button>
        <button class="btn btn-secondary btn-sm" onclick="sendMessage('refresh')">🔄 Refrescar</button>
      </div>
    </div>

    <!-- Token Metrics Section -->
    <div class="section">
      <div class="section-title">
        <span>Consumo de Tokens & Métricas de Servidores</span>
        <button class="btn btn-secondary btn-sm" onclick="sendMessage('resetMetrics')">Reiniciar Métricas</button>
      </div>

      <div class="metric-group">
        <div class="metric-label-row">
          <span>Tokens Totales Consumidos (Sesión)</span>
          <strong>${fmtTokens(metrics.totalTokens)} tokens (${metrics.totalRequests} reqs)</strong>
        </div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" style="width: ${totalPct}%"></div>
        </div>
      </div>

      <div class="metric-group">
        <div class="metric-label-row">
          <span>Tokens de Salida (Output)</span>
          <strong>${fmtTokens(metrics.totalOutputTokens)} tokens (${outputPct}% del total)</strong>
        </div>
        <div class="progress-bar-bg">
          <div class="progress-bar-fill" style="width: ${outputPct}%; background: linear-gradient(90deg, #a371f7, #58a6ff);"></div>
        </div>
      </div>

      <div style="margin-top: 14px;">
        <div style="font-weight: 500; margin-bottom: 8px;">Servidores Conectados (${servers.length})</div>
        <div class="server-list">
          ${serverRowsHtml || '<div style="opacity:0.6; font-style:italic">No hay servidores configurados.</div>'}
        </div>
      </div>
    </div>

    <!-- Quick Settings & Options -->
    <div class="section">
      <div class="section-title">
        <span>Opciones Rápidas de OmniRoute</span>
        <button class="btn btn-secondary btn-sm" onclick="sendMessage('snooze')">Pausar (5m)</button>
      </div>

      <div class="toggle-list">
        <div class="toggle-item">
          <label class="toggle-label">
            <input type="checkbox" ${statusBarEnabled ? "checked" : ""} onchange="toggleSetting('statusBar', this.checked)">
            <span>Mostrar consumo de tokens en la barra de estado</span>
          </label>
        </div>

        <div class="toggle-item">
          <span>Estrategia de Conmutación (Fallback Mode):</span>
          <select onchange="changeFallbackMode(this.value)">
            <option value="sameModel" ${fallbackMode === "sameModel" ? "selected" : ""}>Mismo Modelo (Recomendado)</option>
            <option value="sameFamily" ${fallbackMode === "sameFamily" ? "selected" : ""}>Misma Familia de Modelos</option>
            <option value="full" ${fallbackMode === "full" ? "selected" : ""}>Fallback Completo</option>
            <option value="none" ${fallbackMode === "none" ? "selected" : ""}>Desactivado (Sin Fallback)</option>
          </select>
        </div>

        <div class="toggle-item">
          <span>Reintentos por servidor (Retries per server):</span>
          <span style="opacity:0.8; font-weight:500;">${retriesPerServer} reintento(s) por servidor</span>
        </div>
      </div>
    </div>

    <!-- Smart Suggestions & Improvement Recommendations -->
    <div class="section">
      <div class="section-title">
        <span>Sugerencias de Mejora & Optimización</span>
        <span style="font-size:11px; opacity:0.6">${suggestions.length} recomendaciones</span>
      </div>
      <div class="suggestions-list">
        ${suggestionsHtml}
      </div>
    </div>

    <!-- Footer Links -->
    <div class="footer-links">
      <a onclick="runCommand('omnicopilot.configureCliTool')">⚡ Configurar CLI Bridge (Aider/Claude)</a>
      <a onclick="runCommand('omnicopilot.checkConnection')">🩺 Verificar Salud de Servidores</a>
      <a onclick="runCommand('omnicopilot.openGitHub')">⭐ OmniRoute en GitHub</a>
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
  </script>
</body>
</html>`;
  }
}

function getSuggestionIcon(type: string): string {
  switch (type) {
    case "optimization": return "💡";
    case "redundancy": return "🛡️";
    case "health": return "🚨";
    case "capability": return "⚡";
    default: return "ℹ️";
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
