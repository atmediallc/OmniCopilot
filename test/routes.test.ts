import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTransportPreference,
  buildCatalog,
  cachedLoadRoutes,
  clearRouteCooldown,
  getClientForRoute,
  getRouteCooldown,
  invalidateRouteCache,
  isRouteInCooldown,
  markRouteCooldown,
  newRouteId,
  pickFallbackCandidates,
  prefixedId,
  resetAllCooldowns,
  saveRoutes,
  transportPlanForModel,
  vendorForRoute,
  SECRET_PREFIX,
  type CatalogEntry,
} from "../src/routes";
import type { OmniRouteModel } from "../src/types";
import { secretStore, configValues, configUpdates, createMockContext } from "./vscode.mock";

function model(id: string, toolCalling?: boolean): OmniRouteModel {
  return {
    id,
    ...(toolCalling === undefined ? {} : { capabilities: { tool_calling: toolCalling } }),
  };
}

describe("newRouteId", () => {
  it("incrementa sobre ids route-N existentes", () => {
    expect(newRouteId([{ id: "route-1", name: "a", baseUrl: "x" }])).toBe("route-2");
  });
  it("salta ids no numéricos sin romper", () => {
    expect(newRouteId([{ id: "abc", name: "a", baseUrl: "x" }])).toBe("route-1");
  });
});

describe("prefixedId", () => {
  it("usa el id del modelo tal cual, sin prefijo de servidor", () => {
    expect(prefixedId("My Server", "r1", "openai/gpt-4o", new Set())).toBe("openai/gpt-4o");
    expect(prefixedId("   ", "r1", "kimi/k2", new Set())).toBe("kimi/k2");
  });
  it("sufija #routeId solo en colisiones del mismo id de modelo", () => {
    const taken = new Set(["openai/gpt-4o"]);
    expect(prefixedId("My", "r2", "openai/gpt-4o", taken)).toBe("openai/gpt-4o #r2");
  });
});

describe("buildCatalog", () => {
  it("une catálogos de varias rutas y etiqueta entrada con routeId/modelId", () => {
    const catalog = buildCatalog([
      { routeId: "r1", name: "A", models: [model("openai/gpt-4o")] },
      { routeId: "r2", name: "B", models: [model("kimi/k2")] },
    ]);
    expect(catalog).toEqual([
      { entry: { routeId: "r1", routeName: "A", modelId: "openai/gpt-4o", prefixedId: "openai/gpt-4o" }, model: model("openai/gpt-4o") },
      { entry: { routeId: "r2", routeName: "B", modelId: "kimi/k2", prefixedId: "kimi/k2" }, model: model("kimi/k2") },
    ]);
  });
  it("desambigua el mismo modelo id de dos rutas con un sufijo #routeId", () => {
    const catalog = buildCatalog([
      { routeId: "r1", name: "Same", models: [model("openai/gpt-4o")] },
      { routeId: "r2", name: "Same", models: [model("openai/gpt-4o")] },
    ]);
    expect(catalog[0].entry.prefixedId).toBe("openai/gpt-4o");
    expect(catalog[1].entry.prefixedId).toBe("openai/gpt-4o #r2");
  });
  it("ignora id de modelo vacío", () => {
    const catalog = buildCatalog([{ routeId: "r1", name: "A", models: [{ id: "" }, model("x/y")] }]);
    expect(catalog.map((c) => c.entry.modelId)).toEqual(["x/y"]);
  });
});

describe("transportPlanForModel", () => {
  it("orders Responses before explicit Chat Completions or Messages compatibility surfaces", () => {
    expect(transportPlanForModel({ id: "mixed-chat", supported_endpoints: ["chat/completions", "responses"] })).toEqual(["responses", "chatCompletions"]);
    expect(transportPlanForModel({ id: "mixed-messages", supported_endpoints: ["messages", "POST /v1/responses"] })).toEqual(["responses", "messages"]);
  });

  it.each([
    [" CHAT/COMPLETIONS "],
    ["POST ///v1//chat/completions/?stream=true#sse"],
    ["https://api.example.test/v1/chat/completions"],
  ])("selects Chat Completions for chat-only metadata %j", (endpoint) => {
    expect(transportPlanForModel({ id: "chat", supported_endpoints: [endpoint] })).toEqual(["chatCompletions"]);
  });

  it("selects Messages for Messages-only metadata", () => {
    expect(transportPlanForModel({ id: "messages", supported_endpoints: ["POST /v1/messages"] })).toEqual(["messages"]);
  });

  it("uses compatibility fallback for absent, empty, unknown, and deceptive metadata but none for legacy-only", () => {
    expect(transportPlanForModel(undefined)).toEqual(["responses", "chatCompletions"]);
    expect(transportPlanForModel({ id: "empty", supported_endpoints: [] })).toEqual(["responses", "chatCompletions"]);
    expect(transportPlanForModel({ id: "unknown", supported_endpoints: ["future/generate"] })).toEqual(["responses", "chatCompletions"]);
    expect(transportPlanForModel({ id: "deceptive", supported_endpoints: ["chat/completions-preview"] })).toEqual(["responses", "chatCompletions"]);
    expect(transportPlanForModel({ id: "legacy", supported_endpoints: ["completions"] })).toEqual([]);
  });
});

describe("applyTransportPreference", () => {
  it("keeps the plan untouched for auto", () => {
    const plan = ["responses", "chatCompletions"] as const;
    expect(applyTransportPreference(plan, "auto")).toBe(plan);
    expect(applyTransportPreference(["messages"] as const, "auto")).toEqual(["messages"]);
  });

  it("narrows the plan to the preferred transport when supported", () => {
    expect(applyTransportPreference(["responses", "chatCompletions"] as const, "responses")).toEqual(["responses"]);
    expect(applyTransportPreference(["responses", "chatCompletions"] as const, "chatCompletions")).toEqual(["chatCompletions"]);
    expect(applyTransportPreference(["responses", "messages"] as const, "messages")).toEqual(["messages"]);
  });

  it("returns an empty plan when the model does not support the preferred transport", () => {
    expect(applyTransportPreference(["chatCompletions"] as const, "responses")).toEqual([]);
    expect(applyTransportPreference(["responses"] as const, "messages")).toEqual([]);
    expect(applyTransportPreference([] as const, "chatCompletions")).toEqual([]);
  });

  it("permits Chat Completions as universal compatibility wire protocol for any conversational model", () => {
    expect(applyTransportPreference(["responses"] as const, "chatCompletions")).toEqual(["chatCompletions"]);
    expect(applyTransportPreference(["messages"] as const, "chatCompletions")).toEqual(["chatCompletions"]);
  });
});

describe("pickFallbackCandidates", () => {
  function strictModel(
    id: string,
    opts?: {
      toolCalling?: boolean | number;
      vision?: boolean;
      contextLength?: number;
      supportedEndpoints?: string[];
      capabilities?: OmniRouteModel["capabilities"];
    }
  ): OmniRouteModel {
    const hasCaps = opts && "capabilities" in opts;
    const caps = hasCaps
      ? opts.capabilities
      : {
          ...(opts && "toolCalling" in opts ? { tool_calling: opts.toolCalling } : { tool_calling: true }),
          ...(opts && "vision" in opts ? { vision: opts.vision } : { vision: true }),
        };
    return {
      id,
      context_length: opts && "contextLength" in opts ? opts.contextLength : 128000,
      supported_endpoints: opts?.supportedEndpoints,
      capabilities: caps,
    };
  }

  const cat = buildCatalog([
    {
      routeId: "r1",
      name: "A",
      models: [
        strictModel("openai/gpt-4o", { toolCalling: true, vision: true, contextLength: 128000 }),
        strictModel("openai/gpt-4o-mini", { toolCalling: true, vision: true, contextLength: 128000 }),
      ],
    },
    {
      routeId: "r2",
      name: "B",
      models: [
        strictModel("openai/gpt-4o", { toolCalling: true, vision: true, contextLength: 128000 }),
        strictModel("openai/gpt-4o-mini", { toolCalling: true, vision: true, contextLength: 128000 }),
        strictModel("kimi/k2", { toolCalling: true, vision: true, contextLength: 128000 }),
      ],
    },
    {
      routeId: "r3",
      name: "C",
      models: [
        strictModel("openai/gpt-4o", { toolCalling: true, vision: true, contextLength: 128000 }),
      ],
    },
  ]);
  const gpt4o = cat.find((c) => c.entry.routeId === "r1" && c.entry.modelId === "openai/gpt-4o")!.entry;

  it("defaults to askBeforeSwitch mode and selects exact model cross-route", () => {
    const got = pickFallbackCandidates(gpt4o, cat, false);
    expect(got.map((c) => c.routeId)).toEqual(["r2", "r3"]);
    expect(got.every((c) => c.modelId === "openai/gpt-4o")).toBe(true);
  });

  it("never substitutes family or other models even under legacy full or sameFamily modes", () => {
    const gotFull = pickFallbackCandidates(gpt4o, cat, false, "full");
    expect(gotFull.map((c) => ({ route: c.routeId, model: c.modelId }))).toEqual([
      { route: "r2", model: "openai/gpt-4o" },
      { route: "r3", model: "openai/gpt-4o" },
    ]);

    const gotFamily = pickFallbackCandidates(gpt4o, cat, false, "sameFamily");
    expect(gotFamily.map((c) => ({ route: c.routeId, model: c.modelId }))).toEqual([
      { route: "r2", model: "openai/gpt-4o" },
      { route: "r3", model: "openai/gpt-4o" },
    ]);

    const gotSameModel = pickFallbackCandidates(gpt4o, cat, false, "sameModel");
    expect(gotSameModel.map((c) => ({ route: c.routeId, model: c.modelId }))).toEqual([
      { route: "r2", model: "openai/gpt-4o" },
      { route: "r3", model: "openai/gpt-4o" },
    ]);
  });

  it("mode none disables candidate selection", () => {
    const got = pickFallbackCandidates(gpt4o, cat, false, "none");
    expect(got).toEqual([]);
  });

  it("respeta el límite max y excluye el primario", () => {
    const got = pickFallbackCandidates(gpt4o, cat, false, "askBeforeSwitch", 1);
    expect(got).toHaveLength(1);
    expect(got[0].routeId).toBe("r2");
    expect(got[0].modelId).toBe("openai/gpt-4o");
  });

  it("fails closed when primary model has unknown tool_calling capability", () => {
    const unknownCat = buildCatalog([
      {
        routeId: "r1",
        name: "A",
        models: [strictModel("openai/gpt-4o", { capabilities: { vision: true } })],
      },
      {
        routeId: "r2",
        name: "B",
        models: [strictModel("openai/gpt-4o", { toolCalling: true, vision: true })],
      },
    ]);
    const prim = unknownCat.find((c) => c.entry.routeId === "r1")!.entry;
    expect(pickFallbackCandidates(prim, unknownCat, false)).toEqual([]);
  });

  it("fails closed when primary model has unknown vision capability", () => {
    const unknownCat = buildCatalog([
      {
        routeId: "r1",
        name: "A",
        models: [strictModel("openai/gpt-4o", { capabilities: { tool_calling: true } })],
      },
      {
        routeId: "r2",
        name: "B",
        models: [strictModel("openai/gpt-4o", { toolCalling: true, vision: true })],
      },
    ]);
    const prim = unknownCat.find((c) => c.entry.routeId === "r1")!.entry;
    expect(pickFallbackCandidates(prim, unknownCat, false)).toEqual([]);
  });

  it("fails closed when primary model has unknown or non-positive context_length", () => {
    const noContextCat = buildCatalog([
      {
        routeId: "r1",
        name: "A",
        models: [strictModel("openai/gpt-4o", { contextLength: undefined })],
      },
      {
        routeId: "r2",
        name: "B",
        models: [strictModel("openai/gpt-4o", { contextLength: 128000 })],
      },
    ]);
    const prim1 = noContextCat.find((c) => c.entry.routeId === "r1")!.entry;
    expect(pickFallbackCandidates(prim1, noContextCat, false)).toEqual([]);

    const zeroContextCat = buildCatalog([
      {
        routeId: "r1",
        name: "A",
        models: [strictModel("openai/gpt-4o", { contextLength: 0 })],
      },
      {
        routeId: "r2",
        name: "B",
        models: [strictModel("openai/gpt-4o", { contextLength: 128000 })],
      },
    ]);
    const prim2 = zeroContextCat.find((c) => c.entry.routeId === "r1")!.entry;
    expect(pickFallbackCandidates(prim2, zeroContextCat, false)).toEqual([]);
  });

  it("fails closed when primary is not in catalog", () => {
    const missingPrimary: CatalogEntry = {
      routeId: "r99",
      routeName: "NonExistent",
      modelId: "openai/gpt-4o",
      prefixedId: "NonExistent · openai/gpt-4o",
    };
    expect(pickFallbackCandidates(missingPrimary, cat, false)).toEqual([]);
  });

  it("rejects candidate when candidate capabilities are not identical to primary", () => {
    const diffCat = buildCatalog([
      {
        routeId: "r1",
        name: "A",
        models: [strictModel("openai/gpt-4o", { toolCalling: true, vision: true, contextLength: 128000 })],
      },
      {
        routeId: "r2",
        name: "B",
        models: [strictModel("openai/gpt-4o", { toolCalling: false, vision: true, contextLength: 128000 })],
      },
      {
        routeId: "r3",
        name: "C",
        models: [strictModel("openai/gpt-4o", { toolCalling: true, vision: false, contextLength: 128000 })],
      },
      {
        routeId: "r4",
        name: "D",
        models: [strictModel("openai/gpt-4o", { toolCalling: true, vision: true, contextLength: 64000 })],
      },
      {
        routeId: "r5",
        name: "E",
        models: [strictModel("openai/gpt-4o", { toolCalling: true, vision: true, contextLength: 128000 })],
      },
    ]);
    const prim = diffCat.find((c) => c.entry.routeId === "r1")!.entry;
    const got = pickFallbackCandidates(prim, diffCat, false);
    expect(got).toEqual([
      {
        routeId: "r5",
        modelId: "openai/gpt-4o",
        transportPlan: ["responses", "chatCompletions"],
      },
    ]);
  });

  it("matches identical explicit numeric tool_calling capacity", () => {
    const numCat = buildCatalog([
      {
        routeId: "r1",
        name: "A",
        models: [strictModel("openai/gpt-4o", { toolCalling: 64, vision: true, contextLength: 128000 })],
      },
      {
        routeId: "r2",
        name: "B",
        models: [strictModel("openai/gpt-4o", { toolCalling: 32, vision: true, contextLength: 128000 })],
      },
      {
        routeId: "r3",
        name: "C",
        models: [strictModel("openai/gpt-4o", { toolCalling: 64, vision: true, contextLength: 128000 })],
      },
    ]);
    const prim = numCat.find((c) => c.entry.routeId === "r1")!.entry;
    const got = pickFallbackCandidates(prim, numCat, false);
    expect(got.map((c) => c.routeId)).toEqual(["r3"]);
  });

  it("filters candidates when request requirements are not satisfied", () => {
    const noToolsCat = buildCatalog([
      {
        routeId: "r1",
        name: "A",
        models: [strictModel("openai/gpt-4o", { toolCalling: false, vision: true, contextLength: 128000 })],
      },
      {
        routeId: "r2",
        name: "B",
        models: [strictModel("openai/gpt-4o", { toolCalling: false, vision: true, contextLength: 128000 })],
      },
    ]);
    const prim = noToolsCat.find((c) => c.entry.routeId === "r1")!.entry;
    // Request requires tools, but model tool_calling is false
    expect(pickFallbackCandidates(prim, noToolsCat, true)).toEqual([]);
  });

  it("filters out fallback candidates incompatible with the requested transportPreference", () => {
    const mixedCat = buildCatalog([
      {
        routeId: "r1",
        name: "A",
        models: [
          strictModel("primary-model", {
            toolCalling: true,
            vision: true,
            contextLength: 128000,
            supportedEndpoints: ["messages"],
          }),
        ],
      },
      {
        routeId: "r2",
        name: "B",
        models: [
          strictModel("primary-model", {
            toolCalling: true,
            vision: true,
            contextLength: 128000,
            supportedEndpoints: ["messages"],
          }),
        ],
      },
    ]);
    const primary = mixedCat.find((c) => c.entry.routeId === "r1" && c.entry.modelId === "primary-model")!.entry;
    // When transportPreference is "responses", candidates with only "messages" must not be picked
    const got = pickFallbackCandidates(primary, mixedCat, { transportPreference: "responses" });
    expect(got).toEqual([]);

    // When transportPreference is "chatCompletions", conversational candidates remain eligible
    const gotChat = pickFallbackCandidates(primary, mixedCat, { transportPreference: "chatCompletions" });
    expect(gotChat).toHaveLength(1);
    expect(gotChat[0]).toEqual({
      routeId: "r2",
      modelId: "primary-model",
      transportPlan: ["chatCompletions"],
    });
  });
});

describe("vendorForRoute", () => {
  it("genera omniroute-dev-NOMBRE para servidor unico", () => {
    const routes = [{ id: "r1", name: "Ashburn" }];
    expect(vendorForRoute(routes[0], routes)).toBe("omniroute-dev-Ashburn");
  });

  it("agrega el routeId si hay colision de nombres de servidor", () => {
    const routes = [
      { id: "r1", name: "Ashburn" },
      { id: "r2", name: "Ashburn" },
    ];
    expect(vendorForRoute(routes[0], routes)).toBe("omniroute-dev-Ashburn-r1");
    expect(vendorForRoute(routes[1], routes)).toBe("omniroute-dev-Ashburn-r2");
  });
});

describe("saveRoutes", () => {
  beforeEach(() => {
    secretStore.clear();
    configUpdates.length = 0;
    for (const k of Object.keys(configValues)) delete configValues[k];
  });

  function seedPrior(routes: Array<{ id: string; name: string; baseUrl: string }>) {
    configValues["omnicopilot-dev"] = { ...(configValues["omnicopilot-dev"] ?? {}), routes };
  }

  it("mantiene el secreto cuando una ruta existente se guarda sin apiKey", async () => {
    seedPrior([{ id: "route-1", name: "A", baseUrl: "http://a/v1" }]);
    secretStore.set(SECRET_PREFIX + "route-1", "viejakey");
    // El panel envía apiKey:"" si el usuario no la reescribe → no debe borrarse.
    await saveRoutes(createMockContext() as never, [{ id: "route-1", name: "A", baseUrl: "http://a/v1" }]);
    expect(secretStore.get(SECRET_PREFIX + "route-1")).toBe("viejakey");
  });

  it("borra el secreto de rutas eliminadas de la lista", async () => {
    seedPrior([
      { id: "route-1", name: "A", baseUrl: "http://a/v1" },
      { id: "route-2", name: "B", baseUrl: "http://b/v1" },
    ]);
    secretStore.set(SECRET_PREFIX + "route-1", "k1");
    secretStore.set(SECRET_PREFIX + "route-2", "k2");
    await saveRoutes(createMockContext() as never, [{ id: "route-1", name: "A", baseUrl: "http://a/v1" }]);
    expect(secretStore.has(SECRET_PREFIX + "route-2")).toBe(false);
    expect(secretStore.has(SECRET_PREFIX + "route-1")).toBe(true);
  });

  it("guarda la apiKey de rutas con key y mantiene la de las que siguen", async () => {
    secretStore.set(SECRET_PREFIX + "route-1", "k1");
    await saveRoutes(createMockContext() as never, [
      { id: "route-1", name: "A", baseUrl: "http://a/v1" },
      { id: "route-2", name: "B", baseUrl: "http://b/v1", apiKey: "nueva" },
    ]);
    expect(secretStore.get(SECRET_PREFIX + "route-1")).toBe("k1");
    expect(secretStore.get(SECRET_PREFIX + "route-2")).toBe("nueva");
  });

  it("persiste la config con urls normalizadas", async () => {
    await saveRoutes(createMockContext() as never, [
      { id: "route-1", name: "A", baseUrl: "http://a/v1/", apiKey: "x" },
    ]);
    const saved = configUpdates.find((u) => u.key === "routes")?.value as unknown[];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: "route-1", baseUrl: "http://a/v1" });
  });
});

describe("route cache invalidation", () => {
  it("does not publish a route load that completed after invalidation", async () => {
    invalidateRouteCache();
    let releaseSecret!: (value: string | undefined) => void;
    const context = { secrets: { get: vi.fn(() => new Promise<string | undefined>((resolve) => { releaseSecret = resolve; })) } };
    configValues["omnicopilot-dev"] = { routes: [{ id: "old", name: "Old", baseUrl: "http://old.test" }] };
    const pending = cachedLoadRoutes(context as never);
    configValues["omnicopilot-dev"] = { routes: [] };
    invalidateRouteCache();
    releaseSecret(undefined);
    await expect(pending).resolves.toMatchObject([{ id: "old" }]);
    await expect(cachedLoadRoutes(context as never)).resolves.toEqual([]);
    invalidateRouteCache();
    delete configValues["omnicopilot-dev"];
  });
});

describe("getClientForRoute", () => {
  beforeEach(() => {
    invalidateRouteCache();
  });

  it("reutiliza el cliente si las opciones coinciden", () => {
    const route = { id: "r1", name: "A", baseUrl: "http://localhost:20128/v1", apiKey: "key-1" };
    const c1 = getClientForRoute(route, undefined, 5000);
    const c2 = getClientForRoute(route, undefined, 5000);
    expect(c1).toBe(c2);
  });

  it("crea un nuevo cliente si cambia el timeout de primer byte", () => {
    const route = { id: "r1", name: "A", baseUrl: "http://localhost:20128/v1", apiKey: "key-1" };
    const c1 = getClientForRoute(route, undefined, 5000);
    const c2 = getClientForRoute(route, undefined, 10000);
    expect(c1).not.toBe(c2);
    expect(c2.options.streamFirstByteTimeoutMs).toBe(10000);
  });

  it("crea un nuevo cliente si cambia la apiKey o baseUrl", () => {
    const route1 = { id: "r1", name: "A", baseUrl: "http://localhost:20128/v1", apiKey: "key-1" };
    const route2 = { id: "r1", name: "A", baseUrl: "http://localhost:20128/v1", apiKey: "key-2" };
    const c1 = getClientForRoute(route1);
    const c2 = getClientForRoute(route2);
    expect(c1).not.toBe(c2);
    expect(c2.options.apiKey).toBe("key-2");
  });

  it("limpia el pool al llamar invalidateRouteCache", () => {
    const route = { id: "r1", name: "A", baseUrl: "http://localhost:20128/v1" };
    const c1 = getClientForRoute(route);
    invalidateRouteCache();
    const c2 = getClientForRoute(route);
    expect(c1).not.toBe(c2);
  });
});

describe("Route Cooldowns", () => {
  beforeEach(() => {
    resetAllCooldowns();
  });

  it("marks route in cooldown and respects duration", () => {
    markRouteCooldown("route-1", 10_000, 429, "Throttled");
    expect(isRouteInCooldown("route-1")).toBe(true);

    const info = getRouteCooldown("route-1");
    expect(info).toBeDefined();
    expect(info?.routeId).toBe("route-1");
    expect(info?.status).toBe(429);
    expect(info?.reason).toBe("Throttled");
    expect(info?.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it("expires cooldown when time has elapsed", () => {
    vi.useFakeTimers();
    try {
      markRouteCooldown("route-1", 5_000, 503, "Service unavailable");
      expect(isRouteInCooldown("route-1")).toBe(true);

      vi.advanceTimersByTime(5_001);
      expect(isRouteInCooldown("route-1")).toBe(false);
      expect(getRouteCooldown("route-1")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears cooldown on explicit clear or cache invalidation", () => {
    markRouteCooldown("route-1", 10_000, 429);
    markRouteCooldown("route-2", 10_000, 503);

    clearRouteCooldown("route-1");
    expect(isRouteInCooldown("route-1")).toBe(false);
    expect(isRouteInCooldown("route-2")).toBe(true);

    invalidateRouteCache();
    expect(isRouteInCooldown("route-2")).toBe(false);
  });
});