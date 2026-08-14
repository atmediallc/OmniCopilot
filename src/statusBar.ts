import * as vscode from "vscode";
import { makeClientForRoute } from "./routes";
import type { Route } from "./routes";

type Status = "online" | "partial" | "offline" | "checking";

interface ServerHealth {
  name: string;
  online: boolean;
}

/** Live token snapshot for the most recent chat round-trip, fed by the provider. */
export interface ChatUsage {
  serverName: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
}

/** After this idle period without new usage the token readout is cleared. */
const USAGE_STALE_MS = 60_000;

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/** Status-bar "dot": green when every OmniRoute server answers the HEAD
 * /v1/models probe, amber when only some do, red when none do. Also shows
 * how many servers are up and a live token readout. Hover → per-server health
 * plus the latest usage (what model, which server, how many tokens).
 * Click → quick actions menu. */
export class ConnectionStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private timer: ReturnType<typeof setInterval> | undefined;
  private usageTimer: ReturnType<typeof setTimeout> | undefined;
  private status: Status = "checking";
  private health: ServerHealth[] = [];
  private usage: ChatUsage | undefined;
  private disposed = false;

  constructor(
    private readonly getRoutes: () => Promise<Route[]>,
    private readonly log: vscode.LogOutputChannel
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.name = "OmniRoute";
    this.item.command = "omnicopilot.quickActions";
    this.render();
  }

  start(): void {
    this.applyVisibility();
    this.scheduleLoop();
    void this.checkNow();
  }

  /** Feed request outcomes from the provider so the dot reacts instantly. */
  reportActivity(ok: boolean): void {
    this.setStatus(ok ? "online" : "offline");
  }

  /** Live token usage from a streaming chat round-trip. */
  reportUsage(usage: ChatUsage): void {
    if (this.disposed) return;
    this.usage = usage;
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
    this.health = routes.map((r, i) => ({ name: r.name, online: results[i] }));
    const ok = this.health.filter((h) => h.online).length;
    this.setStatus(ok === routes.length ? "online" : ok > 0 ? "partial" : "offline");
    return ok > 0;
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
        this.health
          .map((h) => `${h.online ? "$(check)" : "$(circle-outline)"} ${h.name}`)
          .join("\n")
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