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
    const results = await Promise.all(routes.map((r) => makeClientForRoute(r).ping()));
    const now = Date.now();
    this.health = routes.map((r, i) => {
      const pingOk = results[i];
      const recentActivity = now - (this.lastActive.get(r.id) ?? 0) < 30_000;
      return { routeId: r.id, name: r.name, online: pingOk || recentActivity };
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

  private buildTooltip(main: string): string {
    const lines: string[] = [];

    if (this.health.length > 0) {
      lines.push(
        this.health.map((h) => `${h.online ? "✓" : "○"} ${h.name}`).join("\n")
      );
    }

    if (this.usage) {
      if (lines.length > 0) lines.push("");
      lines.push(
        vscode.l10n.t("Model: {0}", this.usage.modelName),
        vscode.l10n.t("Server: {0}", this.usage.serverName),
        vscode.l10n.t(
          "Tokens: {0} in · {1} out",
          fmtTokens(this.usage.inputTokens),
          fmtTokens(this.usage.outputTokens)
        )
      );
    }

    lines.push("", main, vscode.l10n.t("Click for actions."));
    return lines.join("\n");
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.usageTimer) clearTimeout(this.usageTimer);
    this.item.dispose();
  }
}