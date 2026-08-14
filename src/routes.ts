import * as vscode from "vscode";
import { OmniRouteClient, normalizeBaseUrl } from "./client";
import type { RouteConfig } from "./types";

/** Legacy single-route secret (migrated into route-1). */
export const SECRET_API_KEY = "omnicopilot.apiKey";
/** Per-route secret prefix: `omnicopilot.apiKey.<routeId>`. */
export const SECRET_PREFIX = "omnicopilot.apiKey.";

export interface Route extends RouteConfig {
  apiKey?: string;
}

/** Load configured routes. When `omnicopilot.routes` was never written (null),
 * the legacy `baseUrl`+`apiKey` become `route-1` (silent migration, no config
 * write). An explicit empty array stays empty — no resurrection. */
export async function loadRoutes(context: vscode.ExtensionContext): Promise<Route[]> {
  const cfg = vscode.workspace.getConfiguration("omnicopilot");
  const configured = cfg.get<RouteConfig[] | null>("routes", null);

  if (configured && configured.length > 0) {
    return Promise.all(
      configured.map(async (r) => ({
        id: r.id,
        name: r.name,
        baseUrl: normalizeBaseUrl(r.baseUrl),
        apiKey: (await context.secrets.get(SECRET_PREFIX + r.id)) || undefined,
      }))
    );
  }

  if (configured === null) {
    const legacyUrl = cfg.get<string>("baseUrl", "");
    if (legacyUrl) {
      const legacyKey = await context.secrets.get(SECRET_API_KEY);
      return [
        {
          id: "route-1",
          name: hostLabelOf(legacyUrl),
          baseUrl: normalizeBaseUrl(legacyUrl),
          apiKey: legacyKey || undefined,
        },
      ];
    }
  }

  return [];
}

/** Persist routes: URLs → config, keys → secrets. Deletes secrets of routes
 * that were removed since the last config read. */
export async function saveRoutes(
  context: vscode.ExtensionContext,
  routes: Route[]
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("omnicopilot");
  const prior = cfg.get<RouteConfig[]>("routes", []) ?? [];

  const remaining = new Set(routes.map((r) => r.id));
  for (const p of prior) {
    if (!remaining.has(p.id)) void context.secrets.delete(SECRET_PREFIX + p.id);
  }

  await cfg.update(
    "routes",
    routes.map((r) => ({ id: r.id, name: r.name, baseUrl: normalizeBaseUrl(r.baseUrl) })),
    vscode.ConfigurationTarget.Global
  );

  for (const r of routes) {
    if (r.apiKey) await context.secrets.store(SECRET_PREFIX + r.id, r.apiKey.trim());
  }
}

/** Next sequential route id (`route-N`), monotonic over existing ids. */
export function newRouteId(routes: Route[]): string {
  let max = 0;
  for (const r of routes) {
    const n = Number(r.id.replace(/^route-/, ""));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `route-${max + 1}`;
}

/** Fresh client for a single route (stateless; callers may build them cheaply). */
export function makeClientForRoute(route: Route): OmniRouteClient {
  return new OmniRouteClient({ baseUrl: route.baseUrl, apiKey: route.apiKey });
}

/** Host portion of a URL → auto-generated route name on migration. */
function hostLabelOf(raw: string): string {
  try {
    return new URL(normalizeBaseUrl(raw)).hostname || "route-1";
  } catch {
    return "route-1";
  }
}
