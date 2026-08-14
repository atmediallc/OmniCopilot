import * as vscode from "vscode";
import type { OmniRouteClient } from "./client";

type Status = "online" | "partial" | "offline" | "checking";

/** Status-bar "dot": green when every OmniRoute server answers the HEAD
 * /v1/models probe, amber when only some do, red when none do.
 * Click → quick actions menu. */
export class ConnectionStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private timer: ReturnType<typeof setInterval> | undefined;
  private status: Status = "checking";
  private disposed = false;

  constructor(
    private readonly getClients: () => Promise<OmniRouteClient[]>,
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

  async checkNow(): Promise<boolean> {
    const clients = await this.getClients();
    if (clients.length === 0) {
      this.setStatus("offline");
      return false;
    }
    const results = await Promise.all(clients.map((c) => c.ping()));
    const ok = results.filter(Boolean).length;
    this.setStatus(ok === clients.length ? "online" : ok > 0 ? "partial" : "offline");
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
    switch (this.status) {
      case "online":
        this.item.text = "$(circle-filled) OmniRoute";
        this.item.color = new vscode.ThemeColor("testing.iconPassed");
        this.item.backgroundColor = undefined;
        this.item.tooltip = vscode.l10n.t("All OmniRoute servers online. Click for actions.");
        break;
      case "partial":
        this.item.text = "$(circle-filled) OmniRoute";
        this.item.color = new vscode.ThemeColor("testing.iconWarning");
        this.item.backgroundColor = undefined;
        this.item.tooltip = vscode.l10n.t("Some OmniRoute servers unreachable. Click for actions.");
        break;
      case "offline":
        this.item.text = "$(circle-outline) OmniRoute";
        this.item.color = undefined;
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        this.item.tooltip = vscode.l10n.t("OmniRoute unreachable. Click for actions.");
        break;
      default:
        this.item.text = "$(sync~spin) OmniRoute";
        this.item.color = undefined;
        this.item.backgroundColor = undefined;
        this.item.tooltip = vscode.l10n.t("Checking OmniRoute connection…");
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
  }
}
