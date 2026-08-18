import * as vscode from "vscode";
import type { Route } from "./routes";

export interface ServerMetric {
  routeId: string;
  name: string;
  baseUrl: string;
  online: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requestCount: number;
  successCount: number;
  errorCount: number;
  stallCount: number;
  lastUsedModel?: string;
  lastActiveTimestamp?: number;
}

export interface SessionMetrics {
  sessionStartTime: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalRequests: number;
  totalStalls: number;
  servers: Record<string, ServerMetric>;
}

export interface ImprovementSuggestion {
  id: string;
  type: "optimization" | "redundancy" | "health" | "capability" | "info";
  title: string;
  description: string;
  impact: "High" | "Medium" | "Low";
  actionLabel?: string;
  actionCommand?: string;
  actionArgs?: unknown[];
}

const GLOBAL_STATE_KEY = "omnicopilot.tokenMetrics.v1";

export class MetricsTracker {
  private metrics: SessionMetrics;
  private readonly _onDidChangeMetrics = new vscode.EventEmitter<void>();
  readonly onDidChangeMetrics = this._onDidChangeMetrics.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    const saved = this.context.globalState.get<SessionMetrics>(GLOBAL_STATE_KEY);
    if (saved && typeof saved.totalTokens === "number" && saved.servers) {
      this.metrics = saved;
    } else {
      this.metrics = this.createEmptyMetrics();
    }
  }

  private createEmptyMetrics(): SessionMetrics {
    return {
      sessionStartTime: Date.now(),
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalRequests: 0,
      totalStalls: 0,
      servers: {},
    };
  }

  private persistTimer: NodeJS.Timeout | undefined;

  /** Save metrics state to global storage. */
  private async persist(): Promise<void> {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(async () => {
      this.persistTimer = undefined;
      await this.context.globalState.update(GLOBAL_STATE_KEY, this.metrics);
      // No fire here — callers fire _onDidChangeMetrics immediately for
      // real-time UI updates; persist is just the disk-save debounce.
    }, 1000);
  }

  /** Reset all token usage metrics. */
  async resetMetrics(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    this.metrics = this.createEmptyMetrics();
    await this.context.globalState.update(GLOBAL_STATE_KEY, this.metrics);
    this._onDidChangeMetrics.fire();
  }

  /** Record token usage from a chat response. */
  async recordUsage(
    routeId: string,
    routeName: string,
    baseUrl: string,
    modelName: string,
    inputTokens: number,
    outputTokens: number
  ): Promise<void> {
    const total = inputTokens + outputTokens;
    this.metrics.totalInputTokens += inputTokens;
    this.metrics.totalOutputTokens += outputTokens;
    this.metrics.totalTokens += total;
    this.metrics.totalRequests += 1;

    let server = this.metrics.servers[routeId];
    if (!server) {
      server = {
        routeId,
        name: routeName,
        baseUrl,
        online: true,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        stallCount: 0,
      };
      this.metrics.servers[routeId] = server;
    }

    server.name = routeName;
    server.baseUrl = baseUrl;
    server.inputTokens += inputTokens;
    server.outputTokens += outputTokens;
    server.totalTokens += total;
    server.requestCount += 1;
    server.successCount += 1;
    server.lastUsedModel = modelName;
    server.lastActiveTimestamp = Date.now();
    server.online = true;

    this._onDidChangeMetrics.fire();
    await this.persist();
  }

  /** Record activity / health status for a server. */
  async recordActivity(routeId: string, routeName: string, baseUrl: string, success: boolean): Promise<void> {
    let server = this.metrics.servers[routeId];
    if (!server) {
      server = {
        routeId,
        name: routeName,
        baseUrl,
        online: success,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        stallCount: 0,
      };
      this.metrics.servers[routeId] = server;
    }

    if (routeName && (routeName !== routeId || !server.name)) {
      server.name = routeName;
    }
    if (baseUrl) {
      server.baseUrl = baseUrl;
    }
    server.online = success;
    if (!success) {
      server.errorCount += 1;
    }
    await this.persist();
  }

  /** Record a stream stall (timeout waiting for SSE data). */
  async recordStall(routeId: string, routeName: string, baseUrl: string): Promise<void> {
    this.metrics.totalStalls += 1;
    let server = this.metrics.servers[routeId];
    if (!server) {
      server = {
        routeId,
        name: routeName,
        baseUrl,
        online: true,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        requestCount: 0,
        successCount: 0,
        errorCount: 0,
        stallCount: 0,
      };
      this.metrics.servers[routeId] = server;
    }
    server.stallCount += 1;
    await this.persist();
  }

  /** Get snapshot of current metrics. */
  getMetrics(routes: Route[] = []): SessionMetrics {
    // Ensure all currently configured routes are represented
    for (const r of routes) {
      if (!this.metrics.servers[r.id]) {
        this.metrics.servers[r.id] = {
          routeId: r.id,
          name: r.name,
          baseUrl: r.baseUrl,
          online: true,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          requestCount: 0,
          successCount: 0,
          errorCount: 0,
          stallCount: 0,
        };
      } else {
        this.metrics.servers[r.id].name = r.name;
        this.metrics.servers[r.id].baseUrl = r.baseUrl;
      }
    }
    return this.metrics;
  }

  /** Generate smart system and token improvement suggestions. */
  generateSuggestions(routes: Route[], onlineRouteIds: Set<string>): ImprovementSuggestion[] {
    const suggestions: ImprovementSuggestion[] = [];
    const cfg = vscode.workspace.getConfiguration("omnicopilot");
    const fallbackMode = cfg.get<string>("fallbackMode", "sameModel");

    // 1. Redundancy / Failover check
    if (routes.length === 0) {
      suggestions.push({
        id: "no_routes",
        type: "redundancy",
        title: "No OmniRoute servers configured",
        description: "Add at least one OmniRoute server URL (e.g. http://localhost:20128/v1) to enable chat models.",
        impact: "High",
        actionLabel: "Add Server",
        actionCommand: "omnicopilot.manage",
      });
    } else if (routes.length === 1) {
      suggestions.push({
        id: "single_route",
        type: "redundancy",
        title: "Redundancy & Failover Improvement",
        description: "You have only 1 server configured. Add a second server or backup endpoint (Ollama, Groq, OpenRouter) for automatic failover if the primary fails.",
        impact: "Medium",
        actionLabel: "Configure Servers",
        actionCommand: "omnicopilot.manage",
      });
    } else if (onlineRouteIds.size < routes.length) {
      const offlineCount = routes.length - onlineRouteIds.size;
      suggestions.push({
        id: "offline_servers",
        type: "health",
        title: `${offlineCount} unreachable server(s)`,
        description: "Some configured servers are not responding to health pings. Verify that local proxy services or servers are running.",
        impact: "High",
        actionLabel: "Test Connection",
        actionCommand: "omnicopilot.checkConnection",
      });
    }

    // 2. Fallback Mode optimization
    if (fallbackMode === "none" && routes.length > 1) {
      suggestions.push({
        id: "enable_fallback",
        type: "optimization",
        title: "Enable Auto-fallback",
        description: "Failover is set to 'none'. Change to 'sameModel' or 'full' to automatically redirect failed requests.",
        impact: "Medium",
        actionLabel: "Change Fallback Mode",
        actionCommand: "workbench.action.openSettings",
        actionArgs: ["omnicopilot.fallbackMode"],
      });
    }

    // 3. Token & Cost usage optimization
    if (this.metrics.totalTokens > 50000) {
      suggestions.push({
        id: "high_token_usage",
        type: "optimization",
        title: "Token Usage Optimization",
        description: `You have consumed ${fmtTokens(this.metrics.totalTokens)} tokens in this session. Limit tools sent by adjusting 'omnicopilot.maxTools' to save context.`,
        impact: "Medium",
        actionLabel: "Adjust maxTools",
        actionCommand: "workbench.action.openSettings",
        actionArgs: ["omnicopilot.maxTools"],
      });
    }

    // 4. Stall detection warning
    const stallServers = Object.values(this.metrics.servers).filter((s) => s.stallCount > 0);
    if (stallServers.length > 0) {
      const names = stallServers.map((s) => `${s.name} (${s.stallCount})`).join(", ");
      suggestions.push({
        id: "stream_stalls",
        type: "health",
        title: "Stream Stalls Detected",
        description: `Servers with stalled streams: ${names}. Consider increasing streamFirstByteTimeoutMs or checking server load.`,
        impact: "High",
        actionLabel: "Check Server Health",
        actionCommand: "omnicopilot.showDashboard",
      });
    }

    // 5. CLI Tool integration suggestion
    suggestions.push({
      id: "cli_integration",
      type: "capability",
      title: "CLI Tool Integration (Aider, Claude Code, Cursor)",
      description: "Connect your OmniRoute servers with terminal tools like Claude Code, Aider, OpenHands, or Cursor via the OmniRoute CLI.",
      impact: "Medium",
      actionLabel: "Configure CLI",
      actionCommand: "omnicopilot.configureCliTool",
    });

    // 5. General status suggestion
    if (routes.length >= 2 && onlineRouteIds.size === routes.length) {
      suggestions.push({
        id: "cluster_healthy",
        type: "info",
        title: "OmniRoute Cluster Fully Operational",
        description: `All ${routes.length} servers are online with active smart fallback (${fallbackMode}).`,
        impact: "Low",
        actionLabel: "Open Dashboard",
        actionCommand: "omnicopilot.openDashboard",
      });
    }

    return suggestions;
  }
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.00$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}
