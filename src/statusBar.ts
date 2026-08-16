import * as vscode from "vscode";
import { makeClientForRoute } from "./routes";
import type { Route } from "./routes";
import type { MetricsTracker } from "./metrics";
import {
  renderStatusText,
  statusColorTokens,
  type StatusKind,
  type StatusSnapshot,
} from "./status/statusRenderer";
import { buildStatusTooltip } from "./status/statusTooltip";

type Status = StatusKind;

interface ServerHealth {
  routeId: string;
  name: string;
  online: boolean;
  latencyMs?: number;
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
  private usageTimer: ReturnType<typeof setTimeout> | undefined;
  private recheckTimer: ReturnType<typeof setTimeout> | undefined;
  private status: Status = "checking";
  private health: ServerHealth[] = [];
  private usage: ChatUsage | undefined;
  private lastActive = new Map<string, number>();
  private disposed = false;
  /** Guards overlapping checkNow() runs so a slow probe can't stack pings. */
  private checking = false;
  /** In-flight chat requests across all provider slots. */
  private activeRequestCount = 0;
  /** Model currently streaming (set by the provider at request start). */
  private activeModel: string | undefined;
  /** Final failure message of the last request, when it errored out. */
  private lastError: string | undefined;
  /** Timestamp of the last successful response (relative-time readout). */
  private lastResponseAt: number | undefined;
  /** Fallback servers used by the last request (status-bar diagnosis). */
  private fallbackCount = 0;
  /** Consecutive all-offline probes; drives the health-check backoff. */
  private consecutiveFailures = 0;
  /** Result of the most recent completed probe (coalescing stack guard). */
  private lastCheckOk = false;
  private loopTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly snapshotChanged = new vscode.EventEmitter<StatusSnapshot>();

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
    this.scheduleNext();
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
      const serverName = existing?.name && existing.name !== routeId ? existing.name : routeId;
      void this.metricsTracker?.recordActivity(routeId, serverName, "", ok);
      // Let a fresh probe confirm the new state right away (300ms debounce
      // coalesces bursts of onActivity from model discovery).
      this.scheduleRecheck();
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
    // A chat round-trip just finished: re-probe servers right away so the
    // dot reflects the real connection (latency + liveness) immediately
    // instead of waiting for the next poll.
    this.scheduleRecheck();
  }

  /** A chat request started streaming: flip the dot to a live "responding"
   * state and record which model is being served. */
  reportRequestStart(routeId: string | undefined, modelName: string): void {
    if (this.disposed) return;
    this.activeRequestCount += 1;
    this.activeModel = modelName;
    if (routeId) this.lastActive.set(routeId, Date.now());
    this.setStatus("streaming");
  }

  /** A chat request settled. `error` carries the surfaced failure message;
   * `fallbacksUsed` counts servers tried before the one that succeeded (or
   * that exhausted the chain). */
  reportRequestEnd(ok: boolean, error: string | undefined, fallbacksUsed = 0): void {
    if (this.disposed) return;
    this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
    this.fallbackCount = fallbacksUsed;
    if (ok) {
      this.lastResponseAt = Date.now();
      this.lastError = undefined;
      this.activeModel = undefined;
      this.setStatus(
        this.health.length === 0
          ? "checking"
          : this.health.every((h) => h.online)
            ? "online"
            : this.health.some((h) => h.online)
              ? "partial"
              : "offline"
      );
    } else {
      this.lastError = error;
      this.activeModel = undefined;
      if (error) {
        this.setStatus("error");
      } else {
        // Cancel/abort without a failure message: fall back to the last
        // known connection state instead of painting the dot red.
        this.setStatus(
          this.health.length === 0
            ? "checking"
            : this.health.every((h) => h.online)
              ? "online"
              : this.health.some((h) => h.online)
                ? "partial"
                : "offline"
        );
      }
    }
    this.render();
    this.scheduleRecheck();
  }

  /** Debounced fresh probe after activity, so the dot tracks reality in near
   * real time without spamming HEADs mid-chat. */
  private scheduleRecheck(): void {
    if (this.disposed) return;
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = undefined;
      void this.checkNow();
    }, 400);
  }

  async checkNow(): Promise<boolean> {
    if (this.checking) return this.lastCheckOk;
    this.checking = true;
    try {
      const routes = await this.getRoutes();
      if (routes.length === 0) {
        this.health = [];
        this.consecutiveFailures += 1;
        this.lastCheckOk = false;
        this.setStatus("offline");
        this.scheduleNext();
        return false;
      }
      const health = await Promise.all(
        routes.map(async (r) => {
          const client = makeClientForRoute(r, this.log);
          const t0 = Date.now();
          const online = await client.ping(3000);
          const latencyMs = Date.now() - t0;
          void this.metricsTracker?.recordActivity(r.id, r.name, r.baseUrl, online);
          return { routeId: r.id, name: r.name, online, latencyMs };
        })
      );
      this.health = health;
      const ok = this.health.filter((h) => h.online).length;
      this.consecutiveFailures = ok > 0 ? 0 : this.consecutiveFailures + 1;
      this.lastCheckOk = ok > 0;
      this.setStatus(ok === routes.length ? "online" : ok > 0 ? "partial" : "offline");
      this.scheduleNext();
      return ok > 0;
    } finally {
      this.checking = false;
    }
  }

  /** routeIds that answered the most recent liveness probe. Used by the chat
   * provider to deprioritize servers that were just unreachable, so a dead
   * proxy isn't tried first on every request. */
  onlineRouteIds(): ReadonlySet<string> {
    return new Set(this.health.filter((h) => h.online).map((h) => h.routeId));
  }

  restart(): void {
    this.applyVisibility();
    this.scheduleNext();
    void this.checkNow();
  }

  private applyVisibility(): void {
    const enabled = vscode.workspace.getConfiguration("omnicopilot").get<boolean>("statusBar", true);
    if (enabled) this.item.show();
    else this.item.hide();
  }

  /** Self-rescheduling probe loop. While every server is offline the interval
   * backs off (up to 4×, capped at 60s) so an unreachable fleet isn't
   * hammered with HEADs; it recovers instantly once a probe succeeds. */
  private scheduleNext(): void {
    if (this.disposed) return;
    if (this.loopTimer) clearTimeout(this.loopTimer);
    const seconds = vscode.workspace
      .getConfiguration("omnicopilot")
      .get<number>("healthCheckIntervalSeconds", 10);
    const base = Math.max(seconds, 5) * 1000;
    const delay = this.consecutiveFailures >= 2 ? Math.min(base * 4, 60_000) : base;
    this.loopTimer = setTimeout(() => void this.checkNow(), delay);
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
    const snap = this.snapshot();
    this.snapshotChanged.fire(snap);
    const main = this.mainLabel(snap.status);
    this.item.text = renderStatusText(snap);
    const tokens = statusColorTokens(snap);
    this.item.color = tokens.color ? new vscode.ThemeColor(tokens.color) : undefined;
    this.item.backgroundColor = tokens.background ? new vscode.ThemeColor(tokens.background) : undefined;

    this.item.tooltip = buildStatusTooltip(
      snap,
      main,
      this.metricsTracker
        ? {
            totalTokens: this.metricsTracker.getMetrics().totalTokens,
            totalInputTokens: this.metricsTracker.getMetrics().totalInputTokens,
            totalOutputTokens: this.metricsTracker.getMetrics().totalOutputTokens,
            totalRequests: this.metricsTracker.getMetrics().totalRequests,
          }
        : undefined
    );
  }

  /** Pure state handed to the renderer — the adapter keeps no formatting. */
  private snapshot(): StatusSnapshot {
    const serverMetrics = this.metricsTracker?.getMetrics().servers ?? {};
    return {
      status: this.status,
      servers: this.health.map((h) => ({
        routeId: h.routeId,
        name: h.name,
        online: h.online,
        latencyMs: h.latencyMs,
        tokens: serverMetrics[h.routeId]?.totalTokens ?? 0,
        requests: serverMetrics[h.routeId]?.requestCount ?? 0,
      })),
      usage: this.usage
        ? {
            serverName: this.usage.serverName,
            modelName: this.usage.modelName,
            inputTokens: this.usage.inputTokens,
            outputTokens: this.usage.outputTokens,
          }
        : undefined,
      lastError: this.lastError,
      lastResponseAt: this.lastResponseAt,
      activeRequestCount: this.activeRequestCount,
      activeModel: this.activeModel,
      fallbackCount: this.fallbackCount,
    };
  }

  private mainLabel(status: Status): string {
    switch (status) {
      case "online":
        return vscode.l10n.t("All OmniRoute servers online.");
      case "partial":
        return vscode.l10n.t("Some OmniRoute servers unreachable.");
      case "offline":
        return vscode.l10n.t("OmniRoute unreachable.");
      case "streaming":
        return vscode.l10n.t("OmniRoute is responding…");
      case "error":
        return this.lastError
          ? vscode.l10n.t("OmniRoute request failed: {0}", this.lastError)
          : vscode.l10n.t("OmniRoute request failed.");
      default:
        return vscode.l10n.t("Checking OmniRoute connection…");
    }
  }

  public getSnapshot(): StatusSnapshot {
    return this.snapshot();
  }

  public onDidChangeSnapshot(listener: (snapshot: StatusSnapshot) => void): vscode.Disposable {
    return this.snapshotChanged.event(listener);
  }

  dispose(): void {
    this.disposed = true;
    if (this.loopTimer) clearTimeout(this.loopTimer);
    if (this.usageTimer) clearTimeout(this.usageTimer);
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.item.dispose();
    this.snapshotChanged.dispose();
  }
}