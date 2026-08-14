# Multi-route (varios servidores) — design

Fecha: 2026-08-14 · Estado: design aprobado

## Objetivo

Permitir configurar **más de un servidor** (endpoint OmniRoute/OpenAI-compatible), cada uno con su
baseUrl + API key. Los catálogos de modelos se **unen**; cada chat se rutea al servidor dueño del
modelo. Fallback ante errores transitorios (503/429) **cruza servidores**.

## Decisiones acordadas por el usuario

- Una "ruta" = un servidor independiente (URL + key propios).
- Ids de modelo expuestos en VS Code **prefijados con el nombre de ruta** (ej. `myserver · openai/gpt-4o`)
  para que sean siempre únicos y se sepa el origen.
- Fallback transitorio **cruza servidores**: mismo modelo en otro servidor → otro modelo del mismo
  servidor → cualquier modelo compatible.
- Gestión de rutas en la **UI del panel** (add/editar/borrar/test). Keys en `context.secrets`, URLs en settings.
- Migración automática de la config de ruta única actual a la primera ruta.

## Arquitectura

| Pieza | Hoy | Multi-ruta |
|-------|-----|-----------|
| Config | `omnicopilot.baseUrl` (única) | `omnicopilot.routes: RouteConfig[]` — `{id, name, baseUrl}`. `baseUrl` legacy queda como fallback de migración |
| Secret | `omnicopilot.apiKey` (única) | `omnicopilot.apiKey.<routeId>` (una secreta por ruta) |
| `OmniRouteClient` | 1 por op | 1 por ruta (sin estado, se crea bajo demanda: `makeClient(routeId)`) |
| Catálogo | `cachedModels` único | `CatalogModel[]` = modelos de todas las rutas etiquetados con `routeId` |
| Enrutado | `client.streamChat(model.omniModelId)` | cliente de la ruta dueña + `omniModelId` original (sin prefijo al API) |
| Fallback | dentro de un servidor | **cruzado**: mismo modelo en otra ruta → familia en la propia → cualquiera compatible |
| Status bar | 1 health | agregado: "2/3 online", verde=all, ámbar=parcial, rojo=none |
| Panel | 1 URL+key | lista de rutas con add/edit/delete/test + dashboard por ruta |

## Archivos nuevos/modificados

- **`src/routes.ts` (nuevo)** — módulo cohesivo y testeable:
  - `loadRoutes(context)`: lee `omnicopilot.routes`; si vacío y existe `baseUrl` legacy → sintetiza
    `route-1` con nombre del host (migración, no escribe config). Resuelve keys desde secrets.
  - `saveRoutes(context, routes, keys)`: escribe array en config + keys en secrets.
  - `prefixedId(routeName, modelId, taken)`: sanitiza, `name · modelId`, garantiza unicidad (sufijo `#id` si colisiona).
  - `buildCatalog(perRouteModels)`: une catálogos, etiqueta cada modelo con `routeId`.
  - `pickFallbackCandidates(model, catalog, needsTools)`: ordena candidatos cruzados
    (mismo `omniModelId` en otra ruta → familia en la propia → compatible global), cap ~4.
- **`src/types.ts`** — añade `RouteConfig {id, name, baseUrl}`; `CatalogModel {routeId, model: OmniRouteModel, prefixedId}`.
- **`src/provider.ts`** — `makeClient(routeId)`; descubre modelos por ruta (una ruta caída no mata la lista:
  se salta, se loguea, status bar ámbar; si TODAS caen → `[]` + ofrecer ayuda como hoy). `toModelInfos`
  opera sobre `CatalogModel`, expone `id = prefixedId`, guarda `routeId` + `omniModelId` original
  (legacy → al API). `provideLanguageModelChatResponse` rutea al cliente de `model.routeId` con la
  cadena de fallback cruzado. La migración legacy→routes es silenciosa (en `loadRoutes`); no hay aviso.
- **`src/extension.ts`** — `makeClient` multi-ruta; `ConnectionStatusBar` recibe lista de rutas.
- **`src/panel.ts`** + **HTML** — lista de rutas, formulario por ruta (name/URL/key), test por ruta,
  dashboard por ruta; botones add/delete (no borrar la última sin confirmar); save → `saveRoutes` →
  `provider.refresh()` + statusbar refresh.
- **`src/statusBar.ts`** — health por ruta en paralelo, estado agregado.
- **`src/cliBridge.ts`** — usar primera ruta (o picker) con `--remote`.
- **`package.json`** — nueva propiedad `omnicopilot.routes` (order tras `baseUrl`); `baseUrl` marcada deprecated.
- **`test/routes.test.ts` (nuevo)** — tests de `loadRoutes` migración, `prefixedId` unicidad/sanitize,
  `buildCatalog`, `pickFallbackCandidates`.

## Manejo de errores

- Descubrimiento: ruta caída → skip + `onActivity(false)` parcial; mínimo una ruta OK al descubrir.
- Chat transitorio (429/5xx): recorre la cadena de candidatos con `delay(200)` como hoy; si todos fallan,
  toast "retried N model(s) across M server(s)". Errores permanentes (4xx/auth) → fallan de inmediato, sin fallback.
- Keys: jamás en config plano ni en logs/log output channel (solo ruta+nombre).

## Testing

- Unit: `routes.ts` (migración legacy, prefijo, catálogo unido, orden de fallback cruzado).
- Reutiliza `pickFallbackModels` existente dentro de la ruta propia.
- `client.test.ts`/`fallback.test.ts` intactos; `mockResolvedValueOnce` para multi-model-discovery.
- Escenarios: 2 rutas, una caída al descubrir; mismo modelo en 2 rutas → ids prefijados y ruteo al dueño;
  503 en ruta A → cae a mismo modelo en ruta B; 4xx en A → error inmediato sin cruzar.

## Fuera de alcance (YAGNI)

- Routing por afinidad/balanceo (siempre dueño del modelo).
- Keys por-uso/rotación automática.
- Filtros/temp/maxOutput per-ruta (siguen globales).