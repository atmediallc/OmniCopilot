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
  lastUsedModel?: string;
  lastActiveTimestamp?: number;
}

export interface SessionMetrics {
  sessionStartTime: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalRequests: number;
  servers: Record<string, ServerMetric>;
}

export interface ImprovementSuggestion {
  id: string;
  type: "optimization" | "redundancy" | "health" | "capability" | "info";
  title: string;
  description: string;
  impact: "Alta" | "Media" | "Baja";
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
      servers: {},
    };
  }

  /** Save metrics state to global storage. */
  private async persist(): Promise<void> {
    await this.context.globalState.update(GLOBAL_STATE_KEY, this.metrics);
    this._onDidChangeMetrics.fire();
  }

  /** Reset all token usage metrics. */
  async resetMetrics(): Promise<void> {
    this.metrics = this.createEmptyMetrics();
    await this.persist();
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
      };
      this.metrics.servers[routeId] = server;
    }

    server.online = success;
    if (!success) {
      server.errorCount += 1;
    }
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
        title: "Sin servidores OmniRoute configurados",
        description: "Agrega al menos una URL de servidor OmniRoute (ej. http://localhost:20128/v1) para habilitar modelos de chat.",
        impact: "Alta",
        actionLabel: "Agregar Servidor",
        actionCommand: "omnicopilot.manage",
      });
    } else if (routes.length === 1) {
      suggestions.push({
        id: "single_route",
        type: "redundancy",
        title: "Mejora de Redundancia y Failover",
        description: "Tienes solo 1 servidor configurado. Agrega un segundo servidor o endpoint de respaldo (Ollama, Groq, OpenRouter) para conmutación automática si falla el principal.",
        impact: "Media",
        actionLabel: "Configurar Servidores",
        actionCommand: "omnicopilot.manage",
      });
    } else if (onlineRouteIds.size < routes.length) {
      const offlineCount = routes.length - onlineRouteIds.size;
      suggestions.push({
        id: "offline_servers",
        type: "health",
        title: `${offlineCount} servidor(es) inalcanzable(s)`,
        description: "Algunos servidores configurados no responden a los pings de salud. Verifica que los servicios proxy o servidores locales estén en ejecución.",
        impact: "Alta",
        actionLabel: "Probar Conexión",
        actionCommand: "omnicopilot.checkConnection",
      });
    }

    // 2. Fallback Mode optimization
    if (fallbackMode === "none" && routes.length > 1) {
      suggestions.push({
        id: "enable_fallback",
        type: "optimization",
        title: "Activar Conmutación Automática (Auto-fallback)",
        description: "La conmutación por error está desactivada ('none'). Cambia a 'sameModel' o 'full' para redirigir peticiones fallidas automáticamente.",
        impact: "Media",
        actionLabel: "Cambiar Modo Fallback",
        actionCommand: "workbench.action.openSettings",
        actionArgs: ["omnicopilot.fallbackMode"],
      });
    }

    // 3. Token & Cost usage optimization
    if (this.metrics.totalTokens > 50000) {
      suggestions.push({
        id: "high_token_usage",
        type: "optimization",
        title: "Optimización de Consumo de Tokens",
        description: `Has consumido ${fmtTokens(this.metrics.totalTokens)} tokens en esta sesión. Puedes limitar las herramientas enviadas ajustando 'omnicopilot.maxTools' para ahorrar contexto.`,
        impact: "Media",
        actionLabel: "Ajustar maxTools",
        actionCommand: "workbench.action.openSettings",
        actionArgs: ["omnicopilot.maxTools"],
      });
    }

    // 4. CLI Tool integration suggestion
    suggestions.push({
      id: "cli_integration",
      type: "capability",
      title: "Integración con Herramientas CLI (Aider, Claude Code, Cursor)",
      description: "Conecta tus servidores OmniRoute con herramientas de terminal como Claude Code, Aider, OpenHands o Cursor mediante la CLI de OmniRoute.",
      impact: "Media",
      actionLabel: "Configurar CLI",
      actionCommand: "omnicopilot.configureCliTool",
    });

    // 5. General status suggestion
    if (routes.length >= 2 && onlineRouteIds.size === routes.length) {
      suggestions.push({
        id: "cluster_healthy",
        type: "info",
        title: "Cluster OmniRoute 100% Operativo",
        description: `Todos los ${routes.length} servidores están en línea con conmutación inteligente activa (${fallbackMode}).`,
        impact: "Baja",
        actionLabel: "Abrir Dashboard",
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
