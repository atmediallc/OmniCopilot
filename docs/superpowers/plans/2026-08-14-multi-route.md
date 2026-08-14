# Multi-Route (Varios Servidores) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configurar más de un servidor OmniRoute/OpenAI-compatible (cada uno con baseUrl + API key), unir sus catálogos en el selector de modelos de Copilot Chat, y rutear cada chat al servidor dueño del modelo con fallback cruzado ante errores transitorios.

**Architecture:** Se introduce un módulo `src/routes.ts` que modela la lista de rutas (config `omnicopilot.routes` + secrets `omnicopilot.apiKey.<routeId>`, con migración silenciosa de la config única legacy). El provider une catálogos por ruta, expone ids prefijados `name · modelId` y rutea cada chat al cliente de la ruta dueña, con una cadena de fallback cruzado (mismo modelo en otra ruta → misma familia en la misma ruta → cualquier compatible). Status bar pasa a estado agregado; el panel se convierte en una lista de rutas editable.

**Tech Stack:** TypeScript, VS Code Extension API (LanguageModelChatProvider, WebviewViewProvider, SecretStorage, configuration), OpenAI-compatible SSE streaming, vitest (con alias `vscode` → `test/vscode.mock.ts`), esbuild.

## Global Constraints

- Keys de API **solo** en `context.secrets`, jamás en config plano ni en logs. En logs solo ruta+nombre.
- Formato heredado: `omnicopilot.apiKey` (secret) + `omnicopilot.baseUrl` (config). La migración es silenciosa en `loadRoutes`; el secret legacy se asigna a la primera ruta migrada.
- Ids de modelo expuestos en VS Code = `prefixedId` (`<nombre-limpiado> · <modelId>`); `omniModelId` (al API) = id original del servidor; `routeId` = dueño.
- Fallback transitorio solo para 408/429/5xx (`isTransientHttpError`). Errores 4xx/auth → error inmediato, sin fallback.
- `npm` (no pnpm). Comandos: `npm test` (vitest), `npm run check-types` (tsc --noEmit), `npm run lint`, `npm run compile`.
- `normalizeBaseUrl` y `serverRootUrl` vienen de `./client`; el retry/backoff del cliente no cambia.

---

### Task 1: `src/types.ts` — tipo `RouteConfig` + `src/routes.ts` núcleo (carga/save/migración/id)

**Files:**
- Modify: `src/types.ts` (añade `RouteConfig`)
- Create: `src/routes.ts` (núcleo: constantes, `loadRoutes`, `saveRoutes`, `newRouteId`, `makeClientForRoute`, `hostLabelOf`)
- Test: `test/routes.test.ts` (solo `newRouteId` — el resto de este task usa `vscode` y se verifica por compilación + suite existente)

**Interfaces:**
- Produces:
  - `export const SECRET_API_KEY = "omnicopilot.apiKey";`
  - `export const SECRET_PREFIX = "omnicopilot.apiKey.";`
  - `export interface Route extends RouteConfig { apiKey?: string; }`
  - `export async function loadRoutes(context: vscode.ExtensionContext): Promise<Route[]>`
  - `export async function saveRoutes(context: vscode.ExtensionContext, routes: Route[]): Promise<void>`
  - `export function newRouteId(routes: Route[]): string`
  - `export function makeClientForRoute(route: Route): OmniRouteClient`
  - `buildCatalog` y `pickFallbackCandidates` (Task 2) consumen `Route`/`CatalogModel`.

- [ ] **Step 1: Escribir el test que falla** — añadir a `test/routes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newRouteId } from "../src/routes";

describe("newRouteId", () => {
  it("incrementa sobre ids route-N existentes", () => {
    expect(newRouteId([{ id: "route-1", name: "a", baseUrl: "x" }])).toBe("route-2");
  });
  it("salta ids no numéricos sin romper", () => {
    expect(newRouteId([{ id: "abc", name: "a", baseUrl: "x" }])).toBe("route-1");
  });
});
```

- [ ] **Step 2: Correr el test para verlo fallar**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/routes'`.

- [ ] **Step 3: Añadir el tipo y el módulo núcleo.** En `src/types.ts`, tras `ModelsResponse`:

```ts
/** One configured server entry (URLs live in config; the API key in secrets). */
export interface RouteConfig {
  id: string;
  name: string;
  baseUrl: string;
}
```

Crear `src/routes.ts`:

```ts
import * as vscode from "vscode";
import { OmniRouteClient, normalizeBaseUrl } from "./client";
import type { OmniRouteModel, RouteConfig } from "./types";

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
```

Nota: `export type { OmniRouteModel }` se añade en Task 2; aquí el import de `OmniRouteModel` todavía sobra — **déjalo sin usar por ahora** (se usará en Task 2) y el lint lo tolera solo si lo marcas. Para que `npm run lint` pase ya, quita `OmniRouteModel` del import en Step 3:

`import type { RouteConfig } from "./types";`

(el import de `OmniRouteModel` se reintroduce en Task 2).

- [ ] **Step 4: Correr el test para verlo pasar**

Run: `npm test`
Expected: PASS — `newRouteId` 2 tests verdes.

- [ ] **Step 5: Verificar compilación/lint**

Run: `npm run check-types && npm run lint`
Expected: texto de error ávido vacío (salida limpia).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/routes.ts test/routes.test.ts
git commit -m "feat: route model + core load/save routes (multi-route foundation)"
```

---

### Task 2: `src/routes.ts` — catálogo unido, prefijo de ids, fallback cruzado + tests

**Files:**
- Modify: `src/routes.ts` (añade `CatalogEntry`, `CatalogModel`, `FallbackCandidate`, `prefixedId`, `buildCatalog`, `pickFallbackCandidates`; reintroduce import type `OmniRouteModel`)
- Test: `test/routes.test.ts` (añade describes de `prefixedId`/`buildCatalog`/`pickFallbackCandidates`)

**Interfaces:**
- Produces:
  - `export interface CatalogEntry { routeId: string; modelId: string; prefixedId: string; }`
  - `export interface CatalogModel { entry: CatalogEntry; model: OmniRouteModel; }`
  - `export interface FallbackCandidate { routeId: string; modelId: string; }`
  - `export interface RouteCatalog { routeId: string; name: string; models: OmniRouteModel[]; }`
  - `export function prefixedId(routeName: string, routeId: string, modelId: string, taken: ReadonlySet<string>): string`
  - `export function buildCatalog(perRoute: RouteCatalog[]): CatalogModel[]`
  - `export function pickFallbackCandidates(primary: CatalogEntry, catalog: CatalogModel[], needsTools: boolean, max?: number): FallbackCandidate[]`

- [ ] **Step 1: Escribir los tests que fallan** — añadir a `test/routes.test.ts`:

```ts
import { buildCatalog, pickFallbackCandidates, prefixedId } from "../src/routes";
import type { OmniRouteModel } from "../src/types";

function model(id: string, toolCalling?: boolean): OmniRouteModel {
  return {
    id,
    ...(toolCalling === undefined ? {} : { capabilities: { tool_calling: toolCalling } }),
  };
}

describe("prefixedId", () => {
  it("sanea el nombre y compone name · model", () => {
    expect(prefixedId("My Server", "r1", "openai/gpt-4o", new Set())).toBe("My Server · openai/gpt-4o");
  });
  it("limpia caracteres raros y usa routeId si el nombre queda vacío", () => {
    expect(prefixedId("a/b:c*", "r1", "kimi/k2", new Set())).toBe("abc · kimi/k2");
    expect(prefixedId("   ", "r1", "kimi/k2", new Set())).toBe("r1 · kimi/k2");
  });
  it("sufija #routeId en colisiones", () => {
    const taken = new Set(["My · openai/gpt-4o"]);
    expect(prefixedId("My", "r2", "openai/gpt-4o", taken)).toBe("My · openai/gpt-4o #r2");
  });
});

describe("buildCatalog", () => {
  it("une catálogos de varias rutas y etiqueta entrada con routeId/modelId", () => {
    const catalog = buildCatalog([
      { routeId: "r1", name: "A", models: [model("openai/gpt-4o")] },
      { routeId: "r2", name: "B", models: [model("kimi/k2")] },
    ]);
    expect(catalog).toEqual([
      { entry: { routeId: "r1", modelId: "openai/gpt-4o", prefixedId: "A · openai/gpt-4o" }, model: model("openai/gpt-4o") },
      { entry: { routeId: "r2", modelId: "kimi/k2", prefixedId: "B · kimi/k2" }, model: model("kimi/k2") },
    ]);
  });
  it("desambigua el mismo modelo id de dos rutas con nombres iguales", () => {
    const catalog = buildCatalog([
      { routeId: "r1", name: "Same", models: [model("openai/gpt-4o")] },
      { routeId: "r2", name: "Same", models: [model("openai/gpt-4o")] },
    ]);
    expect(catalog[0].entry.prefixedId).toBe("Same · openai/gpt-4o");
    expect(catalog[1].entry.prefixedId).toBe("Same · openai/gpt-4o #r2");
  });
  it("ignora id de modelo vacío", () => {
    const catalog = buildCatalog([{ routeId: "r1", name: "A", models: [{ id: "" }, model("x/y")] }]);
    expect(catalog.map((c) => c.entry.modelId)).toEqual(["x/y"]);
  });
});

describe("pickFallbackCandidates", () => {
  const cat = buildCatalog([
    { routeId: "r1", name: "A", models: [model("openai/gpt-4o", true), model("openai/gpt-4o-mini", false)] },
    { routeId: "r2", name: "B", models: [model("openai/gpt-4o"), model("kimi/k2")] },
  ]);
  const gpt4o = cat.find((c) => c.entry.prefixedId === "A · openai/gpt-4o")!.entry;

  it("pone primero el mismo modelo en otra ruta, luego familia en la misma ruta", () => {
    const got = pickFallbackCandidates(gpt4o, cat, false);
    expect(got).toEqual([
      { routeId: "r2", modelId: "openai/gpt-4o" },
      // las tool_calling:false no importan sin tools; familia misma ruta → gpt-4o-mini
    ]);
    expect(got[1]).toEqual({ routeId: "r1", modelId: "openai/gpt-4o-mini" });
  });
  it("excluye modelos sin tool_calling cuando se requieren tools", () => {
    const got = pickFallbackCandidates(gpt4o, cat, true);
    expect(got.every((c) => c.modelId !== "openai/gpt-4o-mini")).toBe(true);
  });
  it("respeta el límite max y excluye el primario", () => {
    const got = pickFallbackCandidates(gpt4o, cat, false, 1);
    expect(got).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Correr los tests para verlos fallar**

Run: `npm test`
Expected: FAIL — `prefixedId` / `buildCatalog` / `pickFallbackCandidates` no exportados.

- [ ] **Step 3: Implementar.** En `src/routes.ts`, cambia el import a:

```ts
import type { OmniRouteModel, RouteConfig } from "./types";
```

y añade al final del archivo:

```ts
/** One model from one route in the united catalog. */
export interface CatalogEntry {
  routeId: string;
  /** Original server model id — the one sent to the API. */
  modelId: string;
  /** Exposed, always-unique VS Code id (`name · modelId`). */
  prefixedId: string;
}

export interface CatalogModel {
  entry: CatalogEntry;
  model: OmniRouteModel;
}

export interface FallbackCandidate {
  routeId: string;
  modelId: string;
}

export interface RouteCatalog {
  routeId: string;
  name: string;
  models: OmniRouteModel[];
}

/** Sanitized, prefixed, unique model id. Collisions get ` #<routeId>` appended. */
export function prefixedId(
  routeName: string,
  routeId: string,
  modelId: string,
  taken: ReadonlySet<string>
): string {
  const clean = routeName.trim().replace(/[^A-Za-z0-9 _.+-]/g, "").slice(0, 20);
  const base = `${clean || routeId} · ${modelId}`;
  return taken.has(base) ? `${base} #${routeId}` : base;
}

/** Union of per-route raw catalogs into deduped, prefixed, route-tagged models. */
export function buildCatalog(perRoute: RouteCatalog[]): CatalogModel[] {
  const taken = new Set<string>();
  const out: CatalogModel[] = [];
  for (const r of perRoute) {
    for (const model of r.models) {
      if (!model?.id) continue;
      const prefixed = prefixedId(r.name, r.routeId, model.id, taken);
      taken.add(prefixed);
      out.push({ entry: { routeId: r.routeId, modelId: model.id, prefixedId: prefixed }, model });
    }
  }
  return out;
}

/** Ordered cross-route fallback candidates for a failing chat request:
 * 1) same original model id on another route, 2) same provider family on the
 * same route, 3) any compatible model elsewhere. Primary excluded. When tools
 * are needed, models reporting `tool_calling: false` are filtered out. */
export function pickFallbackCandidates(
  primary: CatalogEntry,
  catalog: CatalogModel[],
  needsTools: boolean,
  max = 4
): FallbackCandidate[] {
  const compatible = (c: CatalogModel) =>
    !needsTools || c.model.capabilities?.tool_calling !== false;
  const family = primary.modelId.split("/")[0];

  const out: FallbackCandidate[] = [];
  const seen = new Set<string>([primary.prefixedId]);
  const push = (c: CatalogModel) => {
    if (seen.has(c.entry.prefixedId)) return;
    seen.add(c.entry.prefixedId);
    out.push({ routeId: c.entry.routeId, modelId: c.entry.modelId });
  };

  catalog
    .filter((c) => compatible(c) && c.entry.modelId === primary.modelId && c.entry.routeId !== primary.routeId)
    .forEach(push);
  catalog
    .filter(
      (c) =>
        compatible(c) &&
        c.entry.routeId === primary.routeId &&
        c.entry.modelId !== primary.modelId &&
        c.entry.modelId.split("/")[0] === family
    )
    .forEach(push);
  catalog
    .filter((c) => compatible(c) && c.entry.prefixedId !== primary.prefixedId)
    .forEach(push);

  return out.slice(0, max);
}
```

- [ ] **Step 4: Correr los tests para verlos pasar**

Run: `npm test`
Expected: PASS — todas las suites (incluidas las nuevas).

- [ ] **Step 5: Verificar compilación/lint**

Run: `npm run check-types && npm run lint`
Expected: salida limpia.

- [ ] **Step 6: Commit**

```bash
git add src/routes.ts test/routes.test.ts
git commit -m "feat: united catalog, prefixed ids, cross-route fallback ordering"
```

---

### Task 3: `src/provider.ts` — descubrimiento de modelos multi-ruta

**Files:**
- Modify: `src/provider.ts` (imports, `cachedModels` → `CatalogModel[]`, `provideLanguageModelChatInformation` multi-ruta, `toModelInfos`, `offerConnectionHelp`, quita `SECRET_API_KEY`)

**Interfaces:**
- Consumes: `loadRoutes(context)`, `makeClientForRoute(route)`, `buildCatalog(perRoute: RouteCatalog[])`, `CatalogModel`, `CatalogEntry` (de `./routes`)
- Produces: `OmniModelInfo` ahora lleva `omniModelId: string` y `routeId: string`. `cachedModels: CatalogModel[]`.

- [ ] **Step 1: Reescribir la cabecera y el descubrimiento.** En `src/provider.ts`:

Imports — sustituye las líneas 1-4 por:

```ts
import * as vscode from "vscode";
import { OmniRouteClient, OmniRouteError, isTransientHttpError } from "./client";
import { estimateTokens, toOpenAiMessages, toOpenAiTools } from "./convert";
import { buildCatalog, loadRoutes, makeClientForRoute } from "./routes";
import type { ChatRequest, OmniRouteModel } from "./types";
import type { CatalogModel, RouteCatalog } from "./routes";
```

Borra la línea `export const SECRET_API_KEY = "omnicopilot.apiKey";` (se movió a `routes.ts`).

`OmniModelInfo` — añade `routeId`:

```ts
interface OmniModelInfo extends vscode.LanguageModelChatInformation {
  omniModelId: string;
  routeId: string;
}
```

`cachedModels` — línea 36:

```ts
  private cachedModels: CatalogModel[] = [];
```

Reemplaza `makeClient()` (líneas 50-54) por un helper por-ruta:

```ts
  private async clientForRoute(routeId: string): Promise<OmniRouteClient> {
    const routes = await loadRoutes(this.deps.context);
    const route = routes.find((r) => r.id === routeId);
    if (!route) throw new OmniRouteError(`Route ${routeId} is not configured`, undefined);
    return makeClientForRoute(route);
  }
```

Debajo de `getConfig()`, `delay()` se mantiene (lo usa Task 4).

`provideLanguageModelChatInformation` — reemplaza el cuerpo (líneas 58-81):

```ts
  async provideLanguageModelChatInformation(
    options: { silent: boolean },
    token: vscode.CancellationToken
  ): Promise<OmniModelInfo[]> {
    const routes = await loadRoutes(this.deps.context);
    if (routes.length === 0) return [];

    const segments: RouteCatalog[] = await Promise.all(
      routes.map(async (r) => {
        try {
          const models = await makeClientForRoute(r).listModels(token);
          this.deps.onActivity?.(true);
          return { routeId: r.id, name: r.name, models };
        } catch (err) {
          this.deps.onActivity?.(false);
          this.deps.log.warn(`Route "${r.name}" model discovery failed: ${String(err)}`);
          return { routeId: r.id, name: r.name, models: [] };
        }
      })
    );

    const anyModel = segments.some((s) => s.models.length > 0);
    if (!anyModel) {
      // No route answered with a model list. Only prompt when the caller
      // wants it (model picker opened by the user); otherwise contribute none.
      if (!options.silent) void this.offerConnectionHelp();
      return [];
    }

    const catalog = buildCatalog(segments);
    this.cachedModels = catalog;
    const infos = this.toModelInfos(catalog);
    // `this.cachedModels` is read here so Task 3 compiles clean before the
    // chat fallback (Task 4) starts consuming it.
    this.deps.log.info(
      `Listed ${infos.length} models from ${segments.map((s) => `${s.name}(${s.models.length})`).join(", ")} (cached ${this.cachedModels.length})`
    );
    return infos;
  }
```

- [ ] **Step 2: Reescribir `toModelInfos` a catálogo.** Reemplaza el bucle (líneas 100-127):

```ts
    const infos: OmniModelInfo[] = [];
    for (const c of catalog) {
      const model = c.model;
      if (!model?.id) continue;
      if (filter && !filter.test(model.id)) continue;

      const contextLength = model.context_length ?? defaultContext;
      const maxOutputTokens = Math.min(model.max_completion_tokens ?? maxOutput, maxOutput);
      const caps = model.capabilities ?? {};
      const isCombo = model.owned_by === "combo";

      infos.push({
        id: c.entry.prefixedId,
        name: model.display_name?.trim() || model.id,
        family: model.owned_by || "omniroute",
        version: "1.0.0",
        detail: isCombo ? "combo" : model.owned_by,
        tooltip: `OmniRoute · ${model.id}`,
        maxInputTokens: Math.max(contextLength - maxOutputTokens, 1024),
        maxOutputTokens,
        capabilities: {
          toolCalling: caps.tool_calling !== false,
          imageInput: caps.vision === true,
        },
        omniModelId: c.entry.modelId,
        routeId: c.entry.routeId,
      });
    }
    return infos;
```

y la firma cambia a `private toModelInfos(catalog: CatalogModel[]): OmniModelInfo[]` (la anterior `models: OmniRouteModel[]` ya no aplica).

`offerConnectionHelp` — sustituye la lectura de `baseUrl` (líneas 132-134) por:

```ts
    const routes = await loadRoutes(this.deps.context);
    const baseUrl = routes[0]?.baseUrl ?? "http://localhost:20128/v1";
```

- [ ] **Step 3: Nota `noUnusedLocals`** — `cachedModels` ya se lee en el log del Step 1 (`(cached ${this.cachedModels.length})`), por lo que Task 3 compila limpio; el fallback de chat llega en Task 4. `offerConnectionHelp` solo necesita `routes[0]?.baseUrl`.

- [ ] **Step 4: Compilar + lint**

Run: `npm run check-types && npm run lint`
Expected: limpio. (Si algún import de `./types` quedara sin usar, bórralo.)

- [ ] **Step 5: Verificar suite existente**

Run: `npm test`
Expected: 35+ PASS (client/fallback/convert intactos — `routes.ts` compila bajo el mock `vscode`).

- [ ] **Step 6: Commit**

```bash
git add src/provider.ts
git commit -m "feat: provider discovers models across all routes, prefixed ids"
```

---

### Task 4: `src/provider.ts` — enrutado de chat + fallback cruzado

**Files:**
- Modify: `src/provider.ts` (import `pickFallbackCandidates`; `provideLanguageModelChatResponse`)

**Interfaces:**
- Consumes: `pickFallbackCandidates(primary, catalog, needsTools, max?)` de `./routes`.
- Produces: sin nuevas exportaciones. Depende de `cachedModels` de Task 3 (mismo campo).

- [ ] **Step 1: Import del fallback.** En `src/provider.ts`, amplía el import de routes:

```ts
import { buildCatalog, loadRoutes, makeClientForRoute, pickFallbackCandidates } from "./routes";
```

- [ ] **Step 2: Reescribir `provideLanguageModelChatResponse`.** Sustituye las líneas 156-243 completas:

```ts
  async provideLanguageModelChatResponse(
    model: OmniModelInfo,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const log = this.deps.log;

    const request: ChatRequest = {
      model: model.omniModelId,
      messages: toOpenAiMessages(messages),
      stream: true,
      tools: toOpenAiTools(options.tools),
    };

    if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
      request.tool_choice = "required";
    }

    const modelOptions = options.modelOptions as Record<string, unknown> | undefined;
    if (typeof modelOptions?.temperature === "number") {
      request.temperature = modelOptions.temperature;
    }

    // Route per candidate; a route disappearing mid-session is skipped, never
    // fatal. Fallback chain (transient 429/5xx only): primary → same model on
    // another route → same family on the same route → any compatible model.
    const routes = await loadRoutes(this.deps.context);
    const clientByRoute = new Map(routes.map((r) => [r.id, makeClientForRoute(r)]));

    const primaryEntry = this.cachedModels.find((c) => c.entry.prefixedId === model.id)?.entry;
    const fallbacks = primaryEntry
      ? pickFallbackCandidates(primaryEntry, this.cachedModels, Boolean(options.tools?.length))
      : [];
    const candidates = [{ routeId: model.routeId, modelId: model.omniModelId }, ...fallbacks];
    const serverCount = new Set(candidates.map((c) => c.routeId)).size;
    const lastIndex = candidates.length - 1;

    log.debug(
      `Chat → ${model.omniModelId} @${model.routeId} (${request.messages.length} messages, ${request.tools?.length ?? 0} tools)` +
        (fallbacks.length ? `, fallbacks: ${fallbacks.map((f) => `${f.routeId}:${f.modelId}`).join(", ")}` : "")
    );

    const abort = new AbortController();
    const cancelSub = token.onCancellationRequested(() => abort.abort());

    try {
      for (const [i, cand] of candidates.entries()) {
        const client = clientByRoute.get(cand.routeId);
        if (token.isCancellationRequested) return;
        if (!client) continue;
        const last = i === lastIndex;
        const attemptRequest = cand.modelId === model.omniModelId ? request : { ...request, model: cand.modelId };

        try {
          for await (const event of client.streamChat(attemptRequest, abort.signal)) {
            if (token.isCancellationRequested) break;
            if (event.kind === "text") {
              progress.report(new vscode.LanguageModelTextPart(event.text));
            } else {
              let input: Record<string, unknown>;
              try {
                input = JSON.parse(event.args) as Record<string, unknown>;
              } catch {
                log.warn(`Tool call ${event.name} had invalid JSON args; sending {}`);
                input = {};
              }
              progress.report(new vscode.LanguageModelToolCallPart(event.id, event.name, input));
            }
          }
          this.deps.onActivity?.(true);
          return;
        } catch (err) {
          if (token.isCancellationRequested) return;
          const status = err instanceof OmniRouteError ? err.status : undefined;
          const transient = status !== undefined && isTransientHttpError(status);
          if (!transient) {
            this.deps.onActivity?.(false);
            log.error(`Chat request failed: ${String(err)}`);
            throw err;
          }
          if (last) {
            this.deps.onActivity?.(false);
            log.error(`Chat request failed after ${candidates.length} model(s): ${String(err)}`);
            void vscode.window.showWarningMessage(
              vscode.l10n.t(
                "OmniRoute is temporarily unavailable (HTTP {0}). Retried {1} model(s) on {2} server(s) without success — please retry shortly.",
                String(status),
                String(candidates.length),
                String(serverCount)
              )
            );
            throw err;
          }
          log.warn(
            `Model ${cand.modelId} @${cand.routeId} transiently unavailable (HTTP ${status}) — trying fallback`
          );
          await delay(200);
        }
      }
      throw new OmniRouteError("No configured route served this model", undefined);
    } finally {
      cancelSub.dispose();
    }
  }
```

- [ ] **Step 3: Verificar compilación/lint/suite**

Run: `npm run check-types && npm run lint && npm test`
Expected: limpio y 35+ PASS.

- [ ] **Step 4: Commit**

```bash
git add src/provider.ts
git commit -m "feat: chat routed per owning route with cross-route fallback"
```

---

### Task 5: `src/statusBar.ts` — estado agregado (online/partial/offline)

**Files:**
- Modify: `src/statusBar.ts`

**Interfaces:**
- Consumes: `OmniRouteClient` (tipo de `./client`) — el constructor cambia a `(getClients: () => Promise<OmniRouteClient[]>, log)`.
- Produces: `checkNow(): Promise<boolean>` (true si ≥1 ruta online), `reportActivity(ok)`, `restart()`.

- [ ] **Step 1: Reescribir la clase.** Reemplaza las líneas 4-8 y 11-23:

```ts
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
```

- [ ] **Step 2: Reescribir `checkNow` (líneas 35-40):**

```ts
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
```

- [ ] **Step 3: Reescribir `reportActivity` (líneas 30-33):** permanece igual (online/offline).

- [ ] **Step 4: Reescribir `render` (líneas 72-94):**

```ts
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
```

Borra el import `serverRootUrl` de la línea 2 (ya no se usa) y la lectura `const cfg = ...` de `render`.

- [ ] **Step 5: Verificar compilación/lint**

Run: `npm run check-types && npm run lint`
Expected: limpio.

- [ ] **Step 6: Commit**

```bash
git add src/statusBar.ts
git commit -m "feat: status bar aggregates multiple routes (online/partial/offline)"
```

---

### Task 6: `src/extension.ts` — wiring multi-ruta (commands, quick actions, first-run, dashboard)

**Files:**
- Modify: `src/extension.ts`

**Interfaces:**
- Consumes: `loadRoutes(context)`, `makeClientForRoute(route)`, `SECRET_PREFIX` (de `./routes`) — sustituye a `makeClient` local y `SECRET_API_KEY`.
- Produces: nada nuevo; statusBar se construye con `() => loadRoutes(context).then((rs) => rs.map(makeClientForRoute))`.

- [ ] **Step 1: Imports y borrado de `makeClient`.** Línea 2-7:

```ts
import * as vscode from "vscode";
import { OmniRouteClient, serverRootUrl } from "./client";
import { configureCliTool } from "./cliBridge";
import { OmniPanelProvider } from "./panel";
import { OmniRouteChatProvider } from "./provider";
import { SECRET_PREFIX, loadRoutes, makeClientForRoute } from "./routes";
import { ConnectionStatusBar } from "./statusBar";
```

Borra la función `makeClient` (líneas 19-23).

- [ ] **Step 2: Factory del statusBar (línea 30):**

```ts
  statusBar = new ConnectionStatusBar(
    async () => {
      const routes = await loadRoutes(context);
      return routes.map(makeClientForRoute);
    },
    log
  );
```

- [ ] **Step 3: `quickActions` (líneas 144-154).** Sustituye las primeras líneas y el item 0:

```ts
async function quickActions(context: vscode.ExtensionContext): Promise<void> {
  const routes = await loadRoutes(context);
  const results = await Promise.all(routes.map((r) => makeClientForRoute(r).ping(1500)));
  const onlineCount = results.filter(Boolean).length;
  const online = onlineCount > 0;

  const items: Array<vscode.QuickPickItem & { action: string }> = [
    {
      label: online
        ? `$(circle-filled) ${vscode.l10n.t("Online")}`
        : `$(circle-outline) ${vscode.l10n.t("Offline")}`,
      description:
        routes.length === 1
          ? routes[0].baseUrl
          : `${vscode.l10n.t("{0}/{1} online", String(onlineCount), String(routes.length))}`,
      action: "check",
    },
```

- [ ] **Step 4: `checkConnection` (líneas 80-94).**

```ts
  register("omnicopilot.checkConnection", async () => {
    const ok = await statusBar?.checkNow();
    if (ok) {
      const routes = await loadRoutes(context);
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Connected to OmniRoute at {0}.", routes[0]?.baseUrl ?? "")
      );
    } else {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          "OmniRoute is unreachable. Check that it is running (npx omniroute) and that omnicopilot.routes is configured."
        )
      );
    }
  });
```

- [ ] **Step 5: `openDashboard` (líneas 96-110) — picker de ruta si hay >1.**

```ts
  register("omnicopilot.openDashboard", async () => {
    const routes = await loadRoutes(context);
    if (routes.length === 0) return;
    let root: string;
    if (routes.length === 1) {
      root = serverRootUrl(routes[0].baseUrl);
    } else {
      const picked = await vscode.window.showQuickPick(
        routes.map((r) => ({
          label: r.name,
          description: serverRootUrl(r.baseUrl),
          route: r,
        })),
        { title: vscode.l10n.t("OmniRoute: open dashboard") }
      );
      if (!picked) return;
      root = serverRootUrl(picked.route.baseUrl);
    }
    const mode = getConfig().get<string>("dashboardOpen", "external");
    if (mode === "editor") {
      try {
        await vscode.commands.executeCommand("simpleBrowser.show", root);
        return;
      } catch (err) {
        log.warn(`Simple Browser unavailable, falling back to external: ${String(err)}`);
      }
    }
    void vscode.env.openExternal(vscode.Uri.parse(root));
  });
```

- [ ] **Step 6: `checkFirstRun` (líneas 224-227).**

```ts
  const routes = await loadRoutes(context);
  const results = await Promise.all(routes.map((r) => makeClientForRoute(r).ping()));
  const online = results.some(Boolean);
  log.info(`First run — OmniRoute ${online ? "detected" : "not detected"} (${routes.length} route(s))`);
```

- [ ] **Step 7: `setApiKey` (líneas 186-212) — operar sobre una ruta elegida.**

```ts
async function setApiKey(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  optionalFlow = false
): Promise<void> {
  const routes = await loadRoutes(context);
  if (routes.length === 0) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t("Add a route in the OmniRoute panel first, then set its API key.")
    );
    return;
  }
  let route = routes[0];
  if (routes.length > 1) {
    const picked = await vscode.window.showQuickPick(
      routes.map((r) => ({ label: r.name, description: r.baseUrl, route: r })),
      { title: vscode.l10n.t("OmniRoute: pick a server") }
    );
    if (!picked) return;
    route = picked.route;
  }

  const existing = await context.secrets.get(SECRET_PREFIX + route.id);
  const key = await vscode.window.showInputBox({
    title: vscode.l10n.t("OmniRoute API key — {0}", route.name),
    prompt: optionalFlow
      ? vscode.l10n.t(
          "Optional — leave empty if this server does not require an API key. Stored in the OS keychain."
        )
      : vscode.l10n.t("Stored securely in the OS keychain (SecretStorage). Leave empty to clear."),
    value: existing ?? "",
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) return;

  if (key.trim()) {
    await context.secrets.store(SECRET_PREFIX + route.id, key.trim());
    log.info(`API key stored in SecretStorage (${route.id})`);
  } else if (existing) {
    await context.secrets.delete(SECRET_PREFIX + route.id);
    log.info(`API key cleared (${route.id})`);
  }
  if (!optionalFlow) await provider?.refresh();
}
```

- [ ] **Step 8: Verificar compilación/lint**

Run: `npm run check-types && npm run lint`
Expected: limpio. Nota: si `OmniRouteClient` queda sin usar en extension.ts tras los cambios, bórralo del import de `./client`.

- [ ] **Step 9: Commit**

```bash
git add src/extension.ts
git commit -m "feat: multi-route wiring for commands, quick actions, dashboard, first-run"
```

---

### Task 7: `src/cliBridge.ts` — configurar CLI contra una ruta elegida

**Files:**
- Modify: `src/cliBridge.ts`

**Interfaces:**
- Consumes: `loadRoutes(context)` de `./routes`; `serverRootUrl` de `./client`.
- Produces: sin cambios de firma de `configureCliTool`.

- [ ] **Step 1: Import.** Línea 3 sustituye `import { SECRET_API_KEY } from "./provider";` por:

```ts
import { loadRoutes } from "./routes";
import { OmniRouteClient } from "./client";
```

(import de `OmniRouteClient` solo si se usa para tipar — se usará la ruta directamente).

- [ ] **Step 2: Reescribir el cuerpo de `configureCliTool` (líneas 44-83) para elegir ruta.**

```ts
export async function configureCliTool(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
  preselectedToolId?: string
): Promise<void> {
  const tool = preselectedToolId
    ? CLI_TOOLS.find((t) => t.id === preselectedToolId)
    : await pickTool();
  if (!tool) return;

  const routes = await loadRoutes(context);
  if (routes.length === 0) {
    void vscode.window.showWarningMessage(
      vscode.l10n.t("Add an OmniRoute server in the panel before configuring a coding CLI.")
    );
    return;
  }
  let route = routes[0];
  if (routes.length > 1) {
    const picked = await vscode.window.showQuickPick(
      routes.map((r) => ({ label: r.name, description: serverRootUrl(r.baseUrl), route: r })),
      { title: vscode.l10n.t("OmniRoute: pick a server for {0}", tool.label) }
    );
    if (!picked) return;
    route = picked.route;
  }

  const cfg = vscode.workspace.getConfiguration("omnicopilot");
  const cliPath = cfg.get<string>("cliPath", "omniroute").trim() || "omniroute";
  const root = serverRootUrl(route.baseUrl);
  const apiKey = route.apiKey;

  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(root);
  const args = [tool.subcommand];
  if (!isLocal) {
    args.push("--remote", shellQuote(root));
  }

  const command = `${cliPath} ${args.join(" ")}`;
  log.info(`Running in terminal: ${command}${apiKey ? " (API key via env)" : ""}`);

  const existing = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME);
  existing?.dispose();
  const terminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    env: apiKey ? { OMNIROUTE_API_KEY: apiKey } : undefined,
  });
  terminal.show(true);
  terminal.sendText(command, true);

  void vscode.window.showInformationMessage(
    vscode.l10n.t(
      'Configuring {0} through the OmniRoute CLI. If the command is not found, install it with "npm i -g omniroute" or set omnicopilot.cliPath.',
      tool.label
    )
  );
}
```

- [ ] **Step 3: Verificar compilación/lint**

Run: `npm run check-types && npm run lint`
Expected: limpio. Si `OmniRouteClient` del import no se usa, quítalo.

- [ ] **Step 4: Commit**

```bash
git add src/cliBridge.ts
git commit -m "feat: configure coding CLI against a chosen route"
```

---

### Task 8: `src/panel.ts` — UI de lista de rutas (save/clearKey por ruta)

**Files:**
- Modify: `src/panel.ts` (imports, `PanelStatus`, `refreshStatus`, `handleMessage`, `buildStatus`, `html()` completo)

**Interfaces:**
- Consumes: `loadRoutes(context)`, `saveRoutes(context, Route[])`, `makeClientForRoute(route)`, `SECRET_PREFIX` (de `./routes`).
- Produces: mensajes webview `status` (con `routes[]`), `save`, `clearKey`, `action`.

Mensajes webview:
- `status`: `{ type:"status", routes: PanelRoute[], onlineCount, total }` con `PanelRoute { id,name,url,hasKey,online,modelCount }`.
- `save`: `{ type:"save", routes: [{ id,name,url,apiKey? }] }`.
- `clearKey`: `{ type:"clearKey", routeId }`.

- [ ] **Step 1: Imports (líneas 1-3).**

```ts
import * as vscode from "vscode";
import { normalizeBaseUrl } from "./client";
import { SECRET_PREFIX, loadRoutes, makeClientForRoute, saveRoutes } from "./routes";
```

- [ ] **Step 2: Tipos (líneas 5-12).**

```ts
interface PanelRoute {
  id: string;
  name: string;
  url: string;
  hasKey: boolean;
  online: boolean;
  modelCount: number | null;
}

interface PanelStatus {
  type: "status";
  routes: PanelRoute[];
  onlineCount: number;
  total: number;
}
```

- [ ] **Step 3: `handleMessage` `save` y `clearKey` (líneas 66-89).**

```ts
      case "save": {
        const incoming = Array.isArray(msg.routes) ? (msg.routes as unknown[]) : [];
        const routes: Array<{ id: string; name: string; baseUrl: string; apiKey?: string }> = [];
        for (const raw of incoming) {
          const o = raw as { id?: string; name?: string; url?: string; apiKey?: string };
          const key = String(o.apiKey ?? "").trim();
          routes.push({
            id: String(o.id ?? ""),
            name: String(o.name ?? "").trim() || "Route",
            baseUrl: normalizeBaseUrl(String(o.url ?? "")),
            ...(key ? { apiKey: key } : {}),
          });
        }
        if (routes.length === 0) break; // guard: never save an empty route list
        await saveRoutes(this.context, routes);
        this.log.info(`Saved ${routes.length} route(s) via panel`);
        await this.onSettingsSaved();
        await this.refreshStatus();
        break;
      }

      case "clearKey":
        await this.context.secrets.delete(SECRET_PREFIX + String(msg.routeId ?? ""));
        this.log.info("API key cleared via panel");
        await this.refreshStatus();
        break;
```

- [ ] **Step 4: `buildStatus` (líneas 97-123) — por ruta.**

```ts
  private async buildStatus(): Promise<PanelStatus> {
    const routes = await loadRoutes(this.context);
    const routeStatuses = await Promise.all(
      routes.map(async (r) => {
        const client = makeClientForRoute(r);
        const online = await client.ping(3000);
        let modelCount: number | null = null;
        if (online) {
          try {
            modelCount = (await client.listModels()).length;
          } catch {
            modelCount = null;
          }
        }
        return { id: r.id, name: r.name, url: client.baseUrl, hasKey: Boolean(r.apiKey), online, modelCount };
      })
    );
    return {
      type: "status",
      routes: routeStatuses,
      onlineCount: routeStatuses.filter((s) => s.online).length,
      total: routeStatuses.length,
    };
  }
```

- [ ] **Step 5: Reescribir `html()` — lista editable de rutas.** Sustituye el `const S = {...}` (líneas 129-149) y todo el template (líneas 150-251) por:

```ts
  private html(): string {
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    const t = vscode.l10n.t;
    const S = {
      title: t("OmniRoute for Copilot"),
      add: t("Add server"),
      remove: t("Remove this server"),
      serverName: t("Name"),
      serverUrl: t("Base URL"),
      urlPlaceholder: t("http://localhost:20128/v1"),
      apiKey: t("API key"),
      keyPlaceholder: t("paste key (optional)"),
      keyStored: t("A key is stored in the OS keychain. Empty to keep."),
      online: t("Online"),
      offline: t("Offline"),
      save: t("Save servers"),
      saved: t("Saved."),
      summary: t("{0}/{1} servers online"),
      linkRefresh: t("Refresh models in the picker"),
      linkDashboard: t("Open a dashboard"),
      linkCli: t("Configure a coding CLI (Codex, Claude Code…)"),
      linkInstall: t("Install OmniRoute"),
      linkGitHub: t("OmniRoute on GitHub"),
    };
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 10px 14px; font-size: 12px; }
  h3 { margin: 4px 0 10px; font-size: 13px; display: flex; align-items: center; gap: 7px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--vscode-charts-red); display: inline-block; }
  .dot.on { background: var(--vscode-charts-green); }
  .dot.off { background: var(--vscode-charts-red); }
  .card { border: 1px solid var(--vscode-input-border, #555); border-radius: 4px; padding: 8px; margin-bottom: 8px; }
  .row { display: flex; gap: 6px; align-items: center; margin-bottom: 4px; }
  .row label { width: 64px; opacity: .8; flex: none; }
  input[type=text], input[type=password] { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 5px; }
  .status { display: flex; align-items: center; gap: 6px; min-height: 14px; opacity: .9; }
  .remove { background: none; border: none; color: var(--vscode-editorError-foreground); cursor: pointer; font-size: 13px; padding: 0 4px; }
  .remove:disabled { opacity: .35; cursor: default; }
  .hint { opacity: .7; font-style: italic; padding: 6px 0; }
  button.primary { width: 100%; padding: 6px; cursor: pointer; margin-top: 4px; }
  .links { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
  .link { cursor: pointer; opacity: .9; }
  .link:hover { text-decoration: underline; }
</style>
</head>
<body>
<h3><span id="dot" class="dot"></span> ${S.title}</h3>
<div id="summary" style="opacity:.8; margin-bottom:8px"></div>
<div id="routes"></div>
<button id="add" class="primary">＋ ${S.add}</button>
<button id="save" class="primary">${S.save}</button>

<div class="links">
  <div class="link" data-cmd="omnicopilot.refreshModels">$(sync) ${S.linkRefresh}</div>
  <div class="link" data-cmd="omnicopilot.openDashboard">$(dashboard) ${S.linkDashboard}</div>
  <div class="link" data-cmd="omnicopilot.configureCliTool">$(terminal) ${S.linkCli}</div>
  <div class="link" data-cmd="omnicopilot.installOmniRoute">$(cloud-download) ${S.linkInstall}</div>
  <div class="link" data-cmd="omnicopilot.openGitHub">$(github) ${S.linkGitHub}</div>
</div>

<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  function el(tag, props) { const n = document.createElement(tag); if (props) Object.assign(n, props); return n; }
  const host = document.getElementById("routes");
  const dot = document.getElementById("dot");
  const summaryEl = document.getElementById("summary");
  const addBtn = document.getElementById("add");
  const saveBtn = document.getElementById("save");
  let routes = []; // [{id, name, url, hasKey, online, modelCount}]

  function render() {
    host.textContent = "";
    if (routes.length === 0) host.appendChild(el("div", { className: "hint", textContent: "＋ " + "${S.add}" }));
    routes.forEach((r, i) => {
      const card = el("div", { className: "card" });
      const name = el("input", { type: "text", value: r.name || "", maxLength: 40 });
      const url = el("input", { type: "text", value: r.url || "", placeholder: "${S.urlPlaceholder}", spellcheck: false });
      const key = el("input", { type: "password", value: "", placeholder: r.hasKey ? "${S.keyStored}" : "${S.keyPlaceholder}", spellcheck: false });
      const stDot = el("span", { className: "dot" + (r.online ? " on" : " off") });
      const stText = el("span", { textContent: r.online ? "${S.online}" : "${S.offline}" });
      const rem = el("button", { className: "remove", title: "${S.remove}", textContent: "✕" });
      rem.disabled = routes.length <= 1;
      rem.addEventListener("click", () => { routes.splice(i, 1); render(); });

      const row = (label, field) => {
        const rw = el("div", { className: "row" });
        rw.appendChild(el("label", { textContent: label }));
        rw.appendChild(field);
        return rw;
      };
      card.appendChild(row("${S.serverName}", name));
      card.appendChild(row("${S.serverUrl}", url));
      card.appendChild(row("${S.apiKey}", key));
      const st = el("div", { className: "status" });
      st.appendChild(stDot); st.appendChild(stText); st.appendChild(el("span", { style: "flex:1" }));
      card.appendChild(st); card.appendChild(rem);
      card.__idx = i;
      host.appendChild(card);
    });
  }

  addBtn.addEventListener("click", () => {
    routes.push({ id: "new-" + String(Math.random()).slice(2), name: "", url: "", hasKey: false, online: false, modelCount: null });
    render();
  });

  saveBtn.addEventListener("click", () => {
    const payload = [];
    Array.from(host.querySelectorAll(".card")).forEach((cardEl) => {
      const inputs = cardEl.querySelectorAll("input");
      const r = routes[cardEl.__idx];
      payload.push({ id: r?.id ?? "", name: inputs[0].value, url: inputs[1].value, apiKey: inputs[2].value });
    });
    vscodeApi.postMessage({ type: "save", routes: payload });
    saveBtn.textContent = "${S.saved}";
    setTimeout(() => { saveBtn.textContent = "${S.save}"; }, 1200);
  });

  document.querySelectorAll(".link").forEach((lnk) =>
    lnk.addEventListener("click", () => vscodeApi.postMessage({ type: "action", command: lnk.dataset.cmd }))
  );

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type !== "status") return;
    dot.className = "dot" + (msg.onlineCount > 0 ? " on" : " off");
    summaryEl.textContent = msg.total === 1
      ? (msg.routes[0]?.online ? "${S.online}" : "${S.offline}")
      : "${S.summary}".replace("{0}", msg.onlineCount).replace("{1}", msg.total);
    routes = msg.routes.map((r) => ({ id: r.id, name: r.name, url: r.url, hasKey: r.hasKey, online: r.online, modelCount: r.modelCount }));
    render();
  });

  vscodeApi.postMessage({ type: "ready" });
</script>
```

Nota de implementación: `"${S.saved}"`/`"${S.summary}"` etc. dentro del script son interpolaciones de TS del template literal — se resuelven en el build a la cadena localizada (mismo patrón que el panel actual). Los inputs del `save` salen de `routes[card.__idx]` (id estable) + valores actuales del DOM; la key no se reenvía si el campo queda vacío.

- [ ] **Step 6: Verificar compilación/lint**

Run: `npm run check-types && npm run lint`
Expected: limpio. El template es la parte más delicada — si `esbuild` se queja del anidado de template literals, reestructura `card()` con `document.createElement` concatenando `S` directamente (texto plano en lugar de innerHTML con placeholders).

- [ ] **Step 7: Commit**

```bash
git add src/panel.ts
git commit -m "feat: panel manages a list of routes (add/remove/save/test per server)"
```

---

### Task 9: `package.json` + `package.nls.json` — config `omnicopilot.routes`, deprecar `baseUrl`

**Files:**
- Modify: `package.json` (config properties)
- Modify: `package.nls.json` (strings)

**Interfaces:**
- Produces: propiedad `omnicopilot.routes` (array). `omnicopilot.baseUrl` queda con `deprecationMessage` y order alto.

- [ ] **Step 1: `package.json` — insertar `routes` y ajustar `baseUrl`.** En la sección `configuration.properties`, reemplaza la entrada `omnicopilot.baseUrl` (líneas 137-142) por:

```json
        "omnicopilot.routes": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": { "type": "string" },
              "name": { "type": "string" },
              "baseUrl": { "type": "string" }
            },
            "required": ["id", "name", "baseUrl"]
          },
          "default": [],
          "order": 1,
          "description": "%cfg.routes%"
        },
        "omnicopilot.baseUrl": {
          "type": "string",
          "default": "http://localhost:20128/v1",
          "order": 9,
          "deprecationMessage": "%cfg.baseUrlDeprecated%",
          "description": "%cfg.baseUrl%"
        },
```

- [ ] **Step 2: `package.nls.json` — añadir dos strings.**

```json
  "cfg.routes": "List of OmniRoute servers (routes) to expose models from. Each needs an id, a display name and a base URL; API keys are stored securely per route.",
  "cfg.baseUrlDeprecated": "Deprecated: use omnicopilot.routes instead (one entry per server). The legacy value migrates automatically to the first route."
```

- [ ] **Step 3: Verificar compilación notypes + lint**

Run: `npm run check-types && npm run lint`
Expected: limpio.

- [ ] **Step 4: Commit**

```bash
git add package.json package.nls.json
git commit -m "feat: omnicopilot.routes config; deprecate single baseUrl"
```

---

### Task 10: Verificación integral + actualizar nls/l10n restantes

**Files:**
- Modify: `package.nls.json` (si hace falta), `l10n/bundle.l10n.*.json` (solo si el generate lo exige — normalmente no para l10n en runtime)
- Verify: todo el repo

**Interfaces:** ninguna nueva.

- [ ] **Step 1: Full check**

```bash
npm run compile && npm test && npm run lint
```
Expected: esbuild OK, 40+ tests PASS (añadidos ~9 de routes), lint limpio.

- [ ] **Step 2: Revisar referencias huérfanas a `SECRET_API_KEY` / `omnicopilot.baseUrl`**

```bash
grep -rn "SECRET_API_KEY" src/
grep -rn "omnicopilot.apiKey\b" src/
grep -rn 'get<string>("baseUrl"\|"baseUrl",' src/
```
Expected: `SECRET_API_KEY` solo en `src/routes.ts` (constante legacy). Ningún `get("baseUrl"` salvo en `routes.ts` (migración). Si queda alguno en provider/extension/panel/statusBar/cliBridge, apúntalo a `routes.ts`.

- [ ] **Step 3: Commit cualquier ajuste**

```bash
git add -A
git commit -m "chore: multi-route polish — remove legacy baseUrl readers"
```

---

## Self-Review (ejecutado por el planificador sobre el spec)

1. **Spec coverage:** spec pide — ruta múltiple con URL+key ✓ (Task 1); ids prefijados ✓ (Task 2/3); fallback cruzado ✓ (Task 4); status agregado ✓ (Task 5); panel lista add/edit/delete/test ✓ (Task 8); migración legacy→route-1 ✓ (Task 1 `loadRoutes`); keys solo en secrets ✓ (`saveRoutes` + `SECRET_PREFIX`); dashboard por ruta ✓ (Task 6 Step 5); CLI por ruta ✓ (Task 7); config `omnicopilot.routes` + deprecar `baseUrl` ✓ (Task 9).
2. **Placeholder scan:** cada paso tiene código y comandos; el template del panel tiene una advertencia explícita que remite a implementación lineal (no placeholder de contenido).
3. **Type consistency:** `loadRoutes→Route[]`, `buildCatalog→CatalogModel[]`, `pickFallbackCandidates→FallbackCandidate[]{routeId,modelId}`, `OmniModelInfo{omniModelId,routeId}` usados consistentemente en Tasks 2-8. `SECRET_API_KEY`/`SECRET_PREFIX` definidos en Task 1, consumidos en Tasks 6-8.