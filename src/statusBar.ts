import * as vscode from "vscode";
import { OmniRouteClient, serverRootUrl } from "./client";

type Status = "online" | "offline" | "checking";

/** Status-bar "dot": green when the OmniRoute server answers the HEAD
 * /v1/models probe, red when it does not. Click → quick actions menu. */
export class ConnectionStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private timer: ReturnType<typeof setInterval> | undefined;
  private status: Status = "checking";
  private disposed = false;

  constructor(
    private readonly getClient: () => Promise<OmniRouteClient>,
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
    const client = await this.getClient();
    const ok = await client.ping();
    this.setStatus(ok ? "online" : "offline");
    return ok;
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
    const cfg = vscode.workspace.getConfiguration("omnicopilot");
    const root = serverRootUrl(cfg.get<string>("baseUrl", "http://localhost:20128/v1"));
    switch (this.status) {
      case "online":
        this.item.text = "$(circle-filled) OmniRoute";
        this.item.color = new vscode.ThemeColor("testing.iconPassed");
        this.item.backgroundColor = undefined;
        this.item.tooltip = vscode.l10n.t("OmniRoute online — {0}. Click for actions.", root);
        break;
      case "offline":
        this.item.text = "$(circle-outline) OmniRoute";
        this.item.color = undefined;
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
        this.item.tooltip = vscode.l10n.t("OmniRoute unreachable — {0}. Click for actions.", root);
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
