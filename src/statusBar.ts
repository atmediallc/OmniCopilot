import * as vscode from "vscode";
import { makeClientForRoute } from "./routes";
import type { Route } from "./routes";
import type { MetricsTracker } from "./metrics";
import { fmtTokens } from "./metrics";

type Status = "online" | "partial" | "offline" | "checking";

interface ServerHealth {
  routeId: string;
  name: string;
  online: boolean;
}

/** Live token snapshot for the most recent chat round-trip, fed by the provider. */
export interface ChatUsage {
  routeId?: string;
  baseUrl?: string;
  serverName: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
}

/** After this idle period without new usage the token readout is cleared. */
const USAGE_STALE_MS = 60_000;

/** Status-bar "dot": green when every OmniRoute server answers the HEAD
 * /v1/models probe, amber when only some do, red when none do. Also shows
 * how many servers are up and a live token readout. Hover → per-server health
 * plus the latest usage (what model, which server, how many tokens).
 * Click → quick status popup window. */
export class ConnectionStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private timer: ReturnType<typeof setInterval> | undefined;
  private usageTimer: ReturnType<typeof setTimeout> | undefined;
  private status: Status = "checking";
  private health: ServerHealth[] = [];
  private usage: ChatUsage | undefined;
  private lastActive = new Map<string, number>();
  private disposed = false;

  constructor(
    private readonly getRoutes: () => Promise<Route[]>,
    private readonly log: vscode.LogOutputChannel,
    private readonly metricsTracker?: MetricsTracker
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.name = "OmniRoute";
    this.item.command = "omnicopilot.showStatusPopup";
    this.render();
  }

  start(): void {
    this.applyVisibility();
    this.scheduleLoop();
    void this.checkNow();
  }

  /** Feed request outcomes from the provider so the dot reacts instantly per route. */
  reportActivity(ok: boolean, routeId?: string): void {
    if (this.disposed) return;
    if (routeId) {
      if (ok) {
        this.lastActive.set(routeId, Date.now());
      }
      const existing = this.health.find((h) => h.routeId === routeId);
      if (existing) {
        existing.online = ok;
      } else {
        this.health.push({ routeId, name: routeId, online: ok });
      }
      const onlineCount = this.health.filter((h) => h.online).length;
      this.setStatus(
        onlineCount === this.health.length ? "online" : onlineCount > 0 ? "partial" : "offline"
      );
      void this.metricsTracker?.recordActivity(routeId, routeId, "", ok);
    } else {
      if (ok) {
        this.setStatus("online");
      } else {
        void this.checkNow();
      }
    }
  }

  /** Live token usage from a streaming chat round-trip. */
  reportUsage(usage: ChatUsage): void {
    if (this.disposed) return;
    this.usage = usage;
    if (usage.routeId) {
      void this.metricsTracker?.recordUsage(
        usage.routeId,
        usage.serverName,
        usage.baseUrl ?? "",
        usage.modelName,
        usage.inputTokens,
        usage.outputTokens
      );
    }
    if (this.usageTimer) clearTimeout(this.usageTimer);
    this.usageTimer = setTimeout(() => {
      this.usage = undefined;
      if (!this.disposed) this.render();
    }, USAGE_STALE_MS);
    this.render();
  }

  async checkNow(): Promise<boolean> {
    const routes = await this.getRoutes();
    if (routes.length === 0) {
      this.health = [];
      this.setStatus("offline");
      return false;
    }
    const results = await Promise.all(routes.map((r) => makeClientForRoute(r, this.log).ping(3000)));
    this.health = routes.map((r, i) => {
      const pingOk = results[i];
      void this.metricsTracker?.recordActivity(r.id, r.name, r.baseUrl, pingOk);
      return { routeId: r.id, name: r.name, online: pingOk };
    });
    const ok = this.health.filter((h) => h.online).length;
    this.setStatus(ok === routes.length ? "online" : ok > 0 ? "partial" : "offline");
    return ok > 0;
  }

  /** routeIds that answered the most recent liveness probe. Used by the chat
   * provider to deprioritize servers that were just unreachable, so a dead
   * proxy isn't tried first on every request. */
  onlineRouteIds(): ReadonlySet<string> {
    return new Set(this.health.filter((h) => h.online).map((h) => h.routeId));
  }

  restart(): void {
    this.applyVisibility();
    this.scheduleLoop();
    void this.checkNow();
  }

  private applyVisibility(): void {
    const enabled = vscode.workspace.getConfiguration("omnicopilot").get<boolean>("statusBar", true);
    if (enabled) this.item.show();
    else this.item.hide();
  }

  private scheduleLoop(): void {
    if (this.timer) clearInterval(this.timer);
    const seconds = vscode.workspace
      .getConfiguration("omnicopilot")
      .get<number>("healthCheckIntervalSeconds", 30);
    this.timer = setInterval(() => void this.checkNow(), Math.max(seconds, 5) * 1000);
  }

  private setStatus(status: Status): void {
    if (this.disposed || status === this.status) {
      if (!this.disposed) this.render();
      return;
    }
    this.status = status;
    this.log.info(`OmniRoute connection: ${status}`);
    this.render();
  }

  private render(): void {
    const online = this.health.filter((h) => h.online).length;
    let main = "";
    let color: vscode.ThemeColor | undefined;
    let background: vscode.ThemeColor | undefined;
    let icon = "$(circle-filled)";

    switch (this.status) {
      case "online":
        main = vscode.l10n.t("All OmniRoute servers online.");
        color = new vscode.ThemeColor("testing.iconPassed");
        break;
      case "partial":
        main = vscode.l10n.t("Some OmniRoute servers unreachable.");
        color = new vscode.ThemeColor("testing.iconWarning");
        break;
      case "offline":
        main = vscode.l10n.t("OmniRoute unreachable.");
        icon = "$(circle-outline)";
        background = new vscode.ThemeColor("statusBarItem.warningBackground");
        break;
      default:
        main = vscode.l10n.t("Checking OmniRoute connection…");
        icon = "$(sync~spin)";
    }

    let text = `${icon} OmniRoute`;
    if (this.health.length > 0) text += ` ${online}/${this.health.length}`;
    if (this.usage) text += ` · ${fmtTokens(this.usage.inputTokens + this.usage.outputTokens)}`;

    this.item.text = text;
    this.item.color = color;
    this.item.backgroundColor = background;
    this.item.tooltip = this.buildTooltip(main);
  }

  private buildTooltip(main: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    md.appendMarkdown(`### $(symbol-enum-member) OmniRoute\n`);
    md.appendMarkdown(`**${main}**\n\n`);

    if (this.metricsTracker) {
      const metrics = this.metricsTracker.getMetrics();
      const totalFmt = fmtTokens(metrics.totalTokens);
      const inFmt = fmtTokens(metrics.totalInputTokens);
      const outFmt = fmtTokens(metrics.totalOutputTokens);

      md.appendMarkdown(`---\n\n`);
      md.appendMarkdown(`#### $(graph) ${vscode.l10n.t("Métricas de Tokens")}\n`);
      md.appendMarkdown(
        `- **${vscode.l10n.t("Tokens Totales")}:** \`${totalFmt}\` (${vscode.l10n.t("Entrada")}: \`${inFmt}\` · ${vscode.l10n.t("Salida")}: \`${outFmt}\`)\n`
      );
      md.appendMarkdown(
        `- **${vscode.l10n.t("Peticiones Totales")}:** \`${metrics.totalRequests}\`\n\n`
      );
    }

    if (this.usage) {
      md.appendMarkdown(`#### $(zap) ${vscode.l10n.t("Última Petición")}\n`);
      md.appendMarkdown(
        `- **${vscode.l10n.t("Servidor")}:** ${this.usage.serverName} (${this.usage.modelName})\n`
      );
      md.appendMarkdown(
        `- **${vscode.l10n.t("Tokens")}:** \`${fmtTokens(this.usage.inputTokens + this.usage.outputTokens)}\` (In: \`${fmtTokens(this.usage.inputTokens)}\` · Out: \`${fmtTokens(this.usage.outputTokens)}\`)\n\n`
      );
    }

    if (this.health.length > 0) {
      md.appendMarkdown(`#### $(server) ${vscode.l10n.t("Servidores Conectados")}\n`);
      const serverMetrics = this.metricsTracker?.getMetrics().servers ?? {};
      for (const h of this.health) {
        const icon = h.online ? "$(check)" : "$(circle-slash)";
        const statusText = h.online ? vscode.l10n.t("Online") : vscode.l10n.t("Offline");
        const sM = serverMetrics[h.routeId];
        let detail = "";
        if (sM && sM.totalTokens > 0) {
          detail = ` — \`${fmtTokens(sM.totalTokens)}\` (${sM.requestCount} reqs)`;
        }
        md.appendMarkdown(`- ${icon} **${h.name}** (${statusText})${detail}\n`);
      }
      md.appendMarkdown(`\n`);
    }

    md.appendMarkdown(`---\n`);
    md.appendMarkdown(`*$(info) ${vscode.l10n.t("Haz clic para abrir el panel de estado y métricas.")}*`);
    return md;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.usageTimer) clearTimeout(this.usageTimer);
    this.item.dispose();
  }
}