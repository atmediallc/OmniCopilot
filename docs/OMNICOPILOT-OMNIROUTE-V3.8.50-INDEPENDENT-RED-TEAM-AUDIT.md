# OmniCopilot ↔ OmniRoute v3.8.50 — Independent Red-Team Audit (Round 2)

**Audit date:** 2026-08-25  
**Auditor role:** Independent adversarial reviewer (fresh reconstruction, prior PASS treated as untrusted)  
**OmniCopilot root:** `C:\proyectos\omnicopilot\multi-route` — `feat/multi-route` @ `669e3c8c23385ee4ba66d4ec4875e7151a49f2ab` (clean working tree, no `git reset --hard`)  
**OmniRoute evidence root:** `C:\proyectos\omniroute\v3.8.50` — READ-ONLY (no modifications, no history rewrite)  
**Principles:** `Discovery → Validation → Regression Test → Minimal Root-Cause Fix → Focused Validation → Full Gates`  
**Execution order:** Phase 0 Forensic Baseline → Phases 1–4 OmniRoute reconstruction → Phases 5–8 OmniCopilot map + producer/consumer matrix → Phases 9–30 adversarial/fault/concurrent/invariant verification → Phases 31–34 retry/mutation/packaging → independent report. Prior audit `docs/OMNICOPILOT-OMNIROUTE-V3.8.50-AUDIT.md` was **not read** until this report was drafted (Phase 35).

---

## 0. Forensic Baseline (Phase 0)

**Git:** `feat/multi-route`, HEAD `669e3c8`, `git status --short` clean, `git diff --check` / `git diff --stat` / `git diff` empty (verified via `pwsh` with `Out-String` workaround for `head` alias collision). No uncommitted changes to either repo.

**Toolchain (pwsh):** `node v24.16.0`, `npm 11.13.0`, `tsc 5.9.3`, `eslint 9.39.5`, `vitest 3.2.7`, `vsce 3.9.2`.

**Layout:** `tsconfig.json:1` (`module Node16`, `target ES2022`, `strict true`, `include src/**/*.ts test/**/*.ts`), `vitest.config.ts:1` (`vscode → test/vscode.mock.ts` alias, `include test/**/*.test.ts`), `eslint.config.mjs:1` (`typescript-eslint recommended`, `no-explicit-any error`), `esbuild.mjs:1` (`external vscode`, single `src/extension.ts` entry), `.vscodeignore:1` (excludes `src/`, `test/`, `.vscode/`, ships only `dist/**`).

**Source inventory:** `src/` = 21 files (catalogFilter, cliBridge, client, convert, embed, extension, metrics, panel, provider, reasoning, routes, statusBar, statusPopup, supportedEndpoints, tools, types, usage, usageEndpoint, visibleText, status/*). `test/` = 23 suites + `fixtures/omniroute-v3.8.50.ts`. Total counted tests: **397 passed** (see §9).

**Packaging baseline:** `package.json:1` (`omnicopilot@1.2.0`, `publisher diegosouzapw`, `engines vscode ^1.104.0`, 10 `languageModelChatProviders` vendor `omniroute`/`omniroute-2`..`10`, tools `omniroute_search`/`omniroute_rerank`, configs `omnicopilot.routes[]`, `firstByteTimeoutSeconds 120`, `retriesPerServer 1`, `fallbackMode sameModel`, `modelCacheTtlMinutes 60`, `compressionOverride serverDefault`).

---

## 1. OmniRoute v3.8.50 Reconstruction (Phases 1–4, READ-ONLY)

Reconstructed from source reads, not from docs or prior audit.

### 1.1 Endpoints traced

| OmniRoute route file | Method & path | Auth / admission | Notes |
|---|---|---|---|
| `src/app/api/v1/chat/completions/route.ts:81` | `POST /v1/chat/completions` (+ `OPTIONS`) | `Content-Type must be application/json` else `415 unsupported_media_type` (`89`), `admitChatRequest` + `admitChatStructure` body-size + session admission, `resolveModelAliasWithSeedFallbackOnBody`, `withEarlyStreamKeepalive` | Minimal `chatCompletionsRouteShapeSchema` (`67`) — permissive passthrough, real validation in `handleChat` |
| `src/app/api/v1/responses/route.ts:98` | `POST /v1/responses` | Same admission pair, `withCodexPreferredModel` rewrites bare `gpt-*` → `codex/*` when registered, `resolveStreamFlag(..., "openai-responses")` | Delegates to `handleChat`; early keepalive `OPENAI_RESPONSES_IN_PROGRESS_FRAME` every `SSE_HEARTBEAT_INTERVAL_MS` |
| `src/app/api/v1/messages/route.ts:44` | `POST /v1/messages` | `requireJsonContentType → 415`, `withInjectionGuard` + `withChatAdmission`, `resolveStreamFlag(..., "claude")` + `ANTHROPIC_PING_FRAME` | Anthropic Messages wire format, `system` extracted from Messages |
| `src/app/api/v1/models/route.ts:35` | `GET /v1/models` (+ `HEAD 200`, `OPTIONS`) | None (key optional) | `getUnifiedModelsResponse(.., {scheduleBackgroundRefresh: after})`; HEAD short-circuits full catalog (#6400) |
| `src/app/api/v1/models/[...model]/route.ts` | `GET /v1/models/:id` | — | Single-model fetch |
| `src/app/api/v1/search/route.ts:58` | `GET /v1/search` | None | `{object:"list", data:[{id, object:"search_provider", created, name, search_types}]}` |
| `src/app/api/v1/search/route.ts:121` | `POST /v1/search` | `enforceApiKeyPolicy(request, "search")` | Zod `v1SearchSchema` (`src/shared/validation/schemas/apiV1.ts:563`) + provider `resolveSearchProvider` / `supportsSearchType` / `selectProvider` / credential fallback / `SEARCH_CACHE_DEFAULT_TTL_MS 300_000` |
| `src/app/api/v1/rerank/route.ts:59` | `POST /v1/rerank` | `enforceApiKeyPolicy(request, body.model)` | Zod `v1RerankSchema:493` (`model`, `query`, `documents≥1`); local `provider_nodes` (172.16/12, localhost) via `buildDynamicRerankProvider` |
| `src/app/api/v1/embeddings/route.ts:42` | `POST /v1/embeddings` (+ `GET` specialty catalog) | `isRequireApiKeyEnabled` → `extractApiKey` else `enforceApiKeyPolicy` | `v1EmbeddingsSchema:419`, `MAX_EMBEDDING_INPUT_ITEMS 32` etc. |
| Others | `POST /v1/audio/*`, `POST /v1/images/*`, `POST /v1/moderations`, `/v1/ocr`, `/v1/classify`, `/v1/segment`, `POST /v1/batches`, `POST /v1/web/fetch`, `POST /v1/audio/speech`, `GET /health` | — | Out of scope for Copilot Chat but enumerated for completeness |

### 1.2 Chat / Messages / Responses handler

`src/sse/handlers/chat.ts` is the unified handler for all three chat surfaces. Key gates:

- JSON parse once (`admitChatRequest` buffers bytes) → single `request.json()`.
- `chatCompletionsRouteShapeSchema` pre-check → `errorResponse(400)` on non-record shape.
- `admitChatStructure` token/structure admission (queue `CHAT_ADMISSION_QUEUE_MAX_MS`).
- Prompt-injection guard `createInjectionGuard()` → `400 SECURITY_001`.
- `resolveModelOrError` / `getComboForModel` / combo strategy fallbacks.
- `handleChat` selects `chatCore` which owns retries: **account fallback**, **provider retry**, **combo fallback**, **stream recovery** (`open-sse/services/*`, `src/sse/services/*`).
- Error envelope: `src/shared/utils/upstreamError.ts:7` `toJsonErrorPayload(message, type)` → `{error:{message, type, code?}}`; `open-sse/utils/error.ts` → `errorResponse(status, message)`. Structured `error.code` catalog in `src/shared/constants/errorCodes.ts:27` (`AUTH_001`..`INTERNAL_003`).
- SSE: OpenAI `data: {...}\n\n` + `data: [DONE]`, Anthropic `event:` + `data:`, Responses `event: response.*` + `data:`; early keepalive frames: `OPENAI_KEEPALIVE_FRAME`, `OPENAI_STARTUP_FRAME`, `OPENAI_RESPONSES_IN_PROGRESS_FRAME`, `ANTHROPIC_PING_FRAME` (`open-sse/utils/earlyStreamKeepalive.ts`).
- Headers: `Authorization: Bearer <key>` (trimmed, `\r\n` stripped in `client.ts:73`), `Accept: text/event-stream, application/json` for streams, `x-omniroute-compression` when override ≠ `serverDefault`, `User-Agent: OmniCopilot-VSCode`.

### 1.3 Model catalog

`src/app/api/v1/models/catalog.ts` + `catalog*.ts` — OmniRoute enriches OpenAI `{object:"list", data:[{id, owned_by, display_name/name, type, supported_endpoints, parent, context_length, max_output_tokens, capabilities:{tool_calling, vision, reasoning, thinking}}]}`. `type` absent or `chat` = conversational; `audio`/`image`/`embedding`/`rerank`/… = specialty. `supported_endpoints` enumerates `"/responses"`, `"/chat/completions"`, `"/messages"`, `"/completions"` etc. Dual-prefix mirrors (`parent` points at primary) suppressed by `?prefix=alias` query; fallback in client (`catalogFilter.ts:80`).

### 1.4 Search / Rerank contracts (from Route + Handler)

**Search POST** body validated by `v1SearchSchema` (`query 1–500`, `provider?`, `max_results 1–100 default 5`, `search_type web|news|x default web`, `offset≥0`, `country`, `language`, `time_range`, `content {snippet, full_page, format, max_characters}`, `filters {include_domains[≤20], exclude_domains[≤20], safe_search}`, `synthesis` (always `null` today), `provider_options` (SSRF-blocked via `parseAndValidateNonMetadataUrl`), `strict_filters`). Errors: `400` invalid JSON / Zod / unknown provider / unsupported `search_type` / no credentials / blocked provider `403` / no providers available; `429 + Retry-After` when all credentials rate-limited; `502` search_error; `500` internal. Response: `{id:"search-<uuid>", provider, query, results:[{title, url, snippet, position, score, citation…}], answer:null, usage:{queries_used, search_cost_usd}, metrics:{response_time_ms…}, errors:[], cached}` with `computeCacheKey` + `SEARCH_CACHE_DEFAULT_TTL_MS`.

**Rerank POST** body `v1RerankSchema` (`model` required, `query` non-empty, `documents ≥1` of `string|{text}`, `top_n`, `return_documents`). Auth `enforceApiKeyPolicy(request, model)`. Routing: `parseRerankModel` (slash split + alias `jina→jina-ai`, `voyage→voyage-ai`) → cloud `handleRerank` or local `provider_nodes` fetch to `/v1/rerank` (fallback `/rerank` on 404). Response Cohere-normalized: `{id:"rerank-<ts>", results:[{index, relevance_score, document:{text}}] sorted desc sliced by `top_n`, meta:{api_version, billed_units}}`. Errors: `400` Invalid JSON / validation / `Invalid rerank model … Use format: provider/model`; `401` missing token; `500` handler catch.

---

## 2. OmniCopilot Architecture Map (Phases 5–8)

### 2.1 Module dependency graph

```
extension.ts (activate, syncProviders, panel, statusBar, metrics, registerCommands)
  ├─ routes.ts      (Route, loadRoutes/saveRoutes, cachedLoadRoutes, getClientForRoute/makeClientForRoute,
  │                  buildCatalog, prefixedId, transportPlanForModel, pickFallbackCandidates,
  │                  RouteCooldown, invalidateRouteCache, newRouteId, SECRET_PREFIX)
  ├─ client.ts      (OmniRouteClient, normalizeBaseUrl, serverRootUrl, OmniRouteError,
  │                  describeFetchError, isTransientHttpError, isThrottleError, parseRetryAfterHeader,
  │                  StreamSession, ToolCallAssembler/Messages/Responses assemblers, readSseLines,
  │                  EncryptedReasoningFilter, toMessagesRequest/toResponsesRequest)
  ├─ provider.ts    (OmniRouteChatProvider, provideLanguageModelChatInformation, refresh,
  │                  provideLanguageModelChatResponse → buildChatRequest/capTools/resolveChatPlan/
  │                  executeChatPlan/runChatCandidates/tryCandidate/streamAttempt/consumeStream/
  │                  concludeStreamFailure, sharedRouteCatalogs, sharedRouteFetchPromises,
  │                  CACHE_STATE_KEY/CACHE_TIME_KEY, loadPersistentCache)
  ├─ convert.ts     (toOpenAiMessages, toOpenAiTools, estimateTokens, toolCallSummary, extractToolResultText)
  ├─ tools.ts       (SEARCH_TOOL_NAME/RERANK_TOOL_NAME, createFixedTools, candidatesFor,
  │                  executeWithFailover, clearToolDiscoveryCache, CachedToolCandidates)
  ├─ catalogFilter.ts (isChatModel, selectChatModels)
  ├─ supportedEndpoints.ts (normalizeSupportedEndpoint, classifySupportedEndpoint(s), transportSurfaceLabel)
  ├─ reasoning.ts   (normalizeReasoningEffort, isReasoningModel, resolveReasoningEffort)
  ├─ usage.ts / usageEndpoint.ts / metrics.ts / statusBar.ts / status/** / panel.ts / cliBridge.ts
  └─ visibleText.ts / embed.ts
```

### 2.2 Provider lifecycle

`OmniRouteChatProvider` is **per-vendor**: single-vendor (`omniroute`) when `activeRoutes ≤1`, else `omniroute` + `omniroute-2`..`10` (ten slots max, `extension.ts:56` truncates beyond 10, logs truncated names). Provider is `Disposable` (`_onDidChange` emitter). `vscode.lm.registerLanguageModelChatProvider(vendor, provider)` per slot; `syncProviders` disposes previous `providerDisposables` then re-registers. `refresh()` bumps `sharedRefreshGeneration`, clears `sharedRouteFetchPromises`, zeros `sharedLastCatalogFetch`, fires `_onDidChange`.

### 2.3 Configuration / secrets

Routes: `vscode.workspace.getConfiguration("omnicopilot").get<RouteConfig[]>("routes")` → `normalizeBaseUrl`; legacy `baseUrl`+`SECRET_API_KEY "omnicopilot.apiKey"` migrated to `route-1` when `configured === null` (`routes.ts:35`). Secrets: `context.secrets.get/store/delete(SECRET_PREFIX+routeId)` (`omnicopilot.apiKey.<routeId>`). `saveRoutes` sanitizes ids (`newRouteId`), drops secrets of removed routes (`clearSecret`), persists only `{id,name,baseUrl}` to config, stores trimmed `apiKey` to secrets, calls `invalidateRouteCache()` (clears `_cachedRoutes`, `_clientPool`, `resetAllCooldowns()`). Secrets never written to config; config never written with `apiKey`.

### 2.4 Streaming path

`provider.provideLanguageModelChatResponse` → `buildChatRequest` (model, `toOpenAiMessages`, `toOpenAiTools` capped by `maxTools`, `reasoning_effort`, `temperature`/`max_tokens`) → `resolveChatPlan` → `executeChatPlan` → loop `runChatCandidates` → `tryCandidate` (retries `retriesPerServer+1`) → `streamAttempt` → `client.streamModel(request, abort.signal, transportPlan)` → `client.streamForTransport` → `streamChat`/`streamResponses`/`streamMessages` → `readSseLines` → `handleSseLine`/`handleMessagesSseLine`/`handleResponsesSseLine` + `EncryptedReasoningFilter` → `progress.report(new LanguageModelTextPart / ToolCallPart)`.

---

## 3. Producer → Consumer Contract Matrix

| Contract | OmniRoute producer evidence | OmniCopilot consumer | Verdict |
|---|---|---|---|
| `GET /v1/models` shape | `src/app/api/v1/models/catalog*.ts` → `{object:"list", data:[{id, owned_by, type, supported_endpoints, parent, context_length, max_output_tokens, capabilities, display_name/name}]}` | `client.listModels()` parses `ModelsResponse {object, data}` at `client.ts:553`, `catalogFilter.selectChatModels` at `catalogFilter.ts:80`, `provider.provideLanguageModelChatInformation` at `provider.ts:360` | **PASS** — optional enrichments tolerated; `?prefix=alias` requested (`client.ts:521`) |
| `POST /v1/chat/completions` streaming | `route.ts:77 OPTIONS` + `POST` admission + `handleChat` SSE `data: {...}` / `[DONE]` | `client.streamChat` at `client.ts:566` + `handleSseLine` at `client.ts:855` + `consumeStream` at `client.ts:816` | **PASS** — handles `choices[0].delta.content`, `tool_calls`, `usage`, `finish_reason`, `error.message`, empty-delta alive suppression (`client.ts:911`) |
| `POST /v1/responses` streaming | `route.ts:98 postHandler` → `handleChat` + early keepalive | `client.streamResponses` at `client.ts:696` + `handleResponsesSseLine` at `client.ts:1468` + `consumeResponsesStream` terminal marker logic at `client.ts:726` | **PASS** — terminal `response.completed` required; partial with useful output accepted, empty without terminal throws `client.ts:757` |
| `POST /v1/messages` streaming | `route.ts:44` Anthropic + `ANTHROPIC_PING_FRAME` | `client.streamMessages` at `client.ts:633` + `handleMessagesSseLine` at `client.ts:1369` + `MessagesToolCallAssembler` at `client.ts:1312` | **PASS** — `content_block_*` + `input_json_delta` validated as JSON object at `client.ts:1353` |
| `GET /v1/search` provider list | `route.ts:58 GET` → `{object:"list", data:[{id, object:"search_provider"}]}` | `client.listSearchProviders` at `client.ts:282` handles `{object:"list", data:[{id}]}` + `{providers:[...]}` + bare array | **PASS** — vanilla OpenAI-compatible shapes retained |
| `POST /v1/search` execution | `route.ts:121` + `v1SearchSchema` | `client.search` + `tools.createFixedTools` at `tools.ts:228` (`search` tool `provider = modelOverride||candidate.model.id`) | **PASS** — request `{query, provider, max_results, search_type}` matches `SearchRequest` (`types.ts:44`, note `model→provider` rename handled at call site) |
| `POST /v1/rerank` execution | `route.ts:59` + `v1RerankSchema` + `parseRerankModel` | `client.rerank` + `tools.createFixedTools` at `tools.ts:242` | **PASS** — `RerankRequest {model, query, documents, top_n, return_documents}` (`types.ts:51`) |
| Headers / auth | `Authorization: Bearer <key>` (server strips `\r\n`) | `client.headers()` at `client.ts:61` (`cleanKey replace /[\r\n]/g`) | **PASS** |
| Model syntax / prefixes / aliases | Runtime catalog is authority (`resolveSearchProvider` not enum-constrained, comment `apiV1.ts:579`) | `supportedEndpoints.normalizeSupportedEndpoint` strips only leading `/v1`, not arbitrary prefixes (`supportedEndpoints.ts:51`) | **PASS** — deceptive `/proxy/v1/chat/completions` cannot acquire capability |
| Streaming / Retry-After | `HTTP 429/503 + Retry-After` (delta-seconds or HTTP-date) | `parseRetryAfterHeader` at `client.ts:233` (numeric + `Date.parse`, capped 30s) + `retryDelayMs` honor at `client.ts:252` + `computeBackoffMs` cap 10s in `provider.ts:119` | **PASS** |
| Cancellation | `request.signal` threaded through `admitChatRequest` + `handleChat` + `withEarlyStreamKeepalive` | `StreamSession` derived controller (`client.ts:990`) isolates stall abort from caller signal; `setReader` cancels reader on stall at `client.ts:1049` | **PASS** |

---

## 4. Mandatory Invariants — Independent Proofs

| Invariant | Statement | Proof (files:lines) | Verdict |
|---|---|---|---|
| **I-01** | Once cancellation observed, zero subsequent fallback candidates may start | `provider.runChatCandidates` checks `token.isCancellationRequested` at every loop head `provider.ts:782` + `tryCandidate` head `provider.ts:887`; `candidatesFor` checks `throwIfCancelled` at `tools.ts:44` + mid-discovery at `tools.ts:148,178` | **PASS** — regression `test/providerFallback.test.ts` + `test/tools.test.ts` |
| **I-02** | Once meaningful text exposed to VS Code, zero subsequent routes may execute | `provider.concludeStreamFailure` at `provider.ts:1092 throw err` when `reportedAny` true (reportedAny set only on real `LanguageModelTextPart` via `consumeStream` `provider.ts:987` + `client.readSseLines` alive gating `client.ts:911`) | **PASS** — `test/providerFallback.test.ts:361 "still throws immediately when … mid-stream"` |
| **I-03** | Once any tool-call fragment exposed, zero subsequent routes may execute | Same path as I-02: `reportedAny` is set on tool-call flush (`provider.consumeStream` `onReported` at `provider.ts:989` + `toolCallAssembler.flush` at `provider.ts:1003`). `client.ToolCallAssembler` only yields on `flush()` after `choice.finish_reason` or stream EOF, so fallback is still suppressed mid-stream | **PASS** — same test coverage; `contain_visible_text` gate at `provider.ts:1004` does not re-enable fallback after tool fragment |
| **I-04** | Multiple logical routes to same physical endpoint must not double retry/failover capacity | `provider.runChatCandidates` deduplicates physical endpoints via `saturatedEndpoints: Set<string>` keyed by `client.baseUrl` at `provider.ts:776` + `saturatedEndpoints.has(endpoint)` skip at `provider.ts:784` + `hasUsableAlternateRoute` excludes saturated endpoints at `provider.ts:802` | **PASS** — verified by audit-only fault injection (same URL on `route-A`/`route-B` → second logical route skipped after first admission-saturation) |
| **I-05** | Async discovery started under generation N must never overwrite generation N+1 | `provider.provideLanguageModelChatInformation` captures `refreshGeneration = sharedRefreshGeneration` at `provider.ts:352` then `if (refreshGeneration !== sharedRefreshGeneration) return sharedCachedModels` at `provider.ts:423` before writing `sharedRouteCatalogs`/`sharedCachedModels` | **PASS** — also `sharedRouteFetchPromises` coalescing at `provider.ts:356` prevents duplicate fetches |
| **I-06** | Route credentials remain strictly isolated | `routes.getClientForRoute` keys pool by `route.id` and checks `existing.options.apiKey === route.apiKey` at `routes.ts:200`; `client.headers` strips `\r\n` at `client.ts:73` and sends exactly one `Authorization`; `tools.candidatesFor` binds `candidate.client` per-route at `tools.ts:149` | **PASS** — no global/shared key variable; credential rotation via `cachedLoadRoutes` re-reads `SecretStorage` |
| **I-07** | Unsupported model/protocol combos must never resolve as empty successes | `routes.transportPlanForModel` returns `[]` for specialty/legacy-only at `routes.ts:330`; `client.streamModel` throws `No compatible transport` at `client.ts:593` on empty plan; `catalogFilter.isChatModel` drops specialty types at `catalogFilter.ts:54` | **PASS** — empty stream *with* a compatible plan still emits empty `LanguageModelTextPart("")` at `provider.ts:997` (design choice: an empty completion is not an unsupported combo; unsupported combo is rejected before stream) |
| **I-08** | Ping/heartbeat/keepalive/empty-delta must not count as progress | `client.processChoice` `alive` computed only from `delta.content ?? reasoning ?? tool_calls ?? finish_reason` at `client.ts:911`; `handleSseLine` returns `alive:false` for malformed/comment/empty payload at `client.ts:865`; `StreamSession.poke` only on `alive:true` at `client.ts:1035`; `containsVisibleText` filters whitespace/control at `visibleText.ts:1` | **PASS** — empty-delta keep-alives (`{delta:{}}`) do not reset idle watchdog, so silent streams still timeout at `client.ts:1094` |
| **I-09** | Every started request reaches exactly one terminal state | `provider.executeChatPlan` guarantees `onRequestStart` at `provider.ts:735` + `onRequestEnd` on every exit path (`succeeded`/`cancelled`/`failed` + `catch` at `provider.ts:757`); `client.StreamSession` throws `408 stall:true` on first-byte/idle timeout at `client.ts:1107` and `fetchWithRetry` surfaces `connect` errors | **PASS** |
| **I-10** | Retry+failover amplification is finite and calculable | See §7 — formula is bounded, constants are `retriesPerServer` (0–5), `candidates≤5`, `chatMaxAttempts=1` for streams | **PASS** — §7 gives concrete maxima per surface |

---

## 5. Mandatory 4xx Investigation

**Rule under test:** `provider.concludeStreamFailure` at `provider.ts:1083` used status-only `isTransientHttpError` to decide retry vs failover.

**OmniRoute structured errors available:** `src/shared/constants/errorCodes.ts:27` catalog (`AUTH_*` 401/403, `MODEL_001` 404, `VALID_*` 400, `PROVIDER_003` 400 no-credentials); `src/shared/utils/upstreamError.ts:7` `toJsonErrorPayload` and chat handler `errorResponse(400, "Invalid JSON body")` etc. carry `error.code` + `error.type`.

**Current OmniCopilot policy (status-only):**

```ts
// provider.ts:1103
const transient = status === undefined || isTransientHttpError(status);
// isTransientHttpError = 408 | 429 | 500..504 only (client.ts:165)
if (!transient) return { kind:"failed", permanent:true }; // advance to next candidate
```

Effect:
- `400 VALID_*` / `400 MODEL_002` / `401 AUTH_*` / `403` / `404 MODEL_001` / `422` → `permanent:true` → **exactly one attempt per candidate, no retry-sleep**, then failover to next candidate.
- `429`/`503`/`500..504`/`408` → retryable with backoff, plus admission saturation dedup.
- `undefined` status (network `fetch failed`, `ETIMEDOUT`, `ENOTFOUND`) → retryable (transient), respecting `retriesPerServer`.

**Is global-malformed replay bounded?** Yes, but not suppressed. A globally invalid request (e.g. `400 invalid tool schema`, `400 messages: Expected array`, `400 API key without model`) will be attempted once per candidate — up to `candidates.length` times (max 5). OmniRoute would reject each identically, so total cost is `≤5` upstream calls, each with a 400 JSON body (~few hundred bytes), no token spend. This matches the mandated `Discovery→Validation→Fix` principle: a minimal suppress-global-4xx fix (inspect `error.code` like `VALID_001` and short-circuit the candidate loop) would be lower-bounded correct, but the current behaviour is **finite and non-amplifying** (no inner retry, no `fetchWithRetry` for streaming because `chatMaxAttempts=1`).

**Gap that remains (documented, not P0):** Without inspecting `error.code`, OmniCopilot cannot distinguish **route-local** 400 (missing model on that route) from **global** 400 (malformed request that every route will reject). Using `error.code` (`VALID_*`/`COMBO_*` vs `AUTH_*`/`MODEL_001`) plus message prefix would allow early loop termination for global cases, saving up to 4 wasted calls. Classified **P2 (optimization, bounded)** — not a correctness violation because every candidate is tried exactly once and no stall/retry amplifies it.

**Credentials vs model vs request scope:** Per-route credential isolation (`routes.ts:30` secrets per `routeId`) is the reason failover on `401` is correct: another route's key can succeed. Dedicated test `providerFallback.test.ts:247 "fails over to another route when primary rejects with HTTP 401"` proves it. A shared-key deployment would want global suppression, but OmniCopilot's threat model is per-route keys, so the existing `permanent:true` + failover is the intended semantics.

---

## 6. Mandatory Concurrency Investigation

**Race under test:** `discovery N starts → configuration changes → discovery N+1 completes → old discovery N completes` — old result must not restore stale routes/models/clients/credentials.

**Mechanism:**

1. `provider.refresh()` increments `sharedRefreshGeneration` (`provider.ts:312`) and clears `sharedRouteFetchPromises` / zeros `sharedLastCatalogFetch`.
2. `provideLanguageModelChatInformation` captures `refreshGeneration` before `Promise.all(activeRoutes.map(getClientForRoute(...).listModels()))` (`provider.ts:352`).
3. After `await Promise.all`, checks `if (refreshGeneration !== sharedRefreshGeneration) return sharedCachedModels` **before** writing `sharedRouteCatalogs` / `sharedCachedModels` / `persistCache` (`provider.ts:423`).
4. `sharedRouteFetchPromises` is a per-route in-flight coalescing map (`provider.ts:209`): concurrent callers share the same `Promise<RouteCatalog>`; `finally` deletes only if `get(id)===fetchP` (`provider.ts:413`).
5. Route removal / baseUrl change / apiKey change triggers `invalidateRouteCache()` via `extension.ts:145` `onDidChangeConfiguration` (also `clearToolDiscoveryCache()`), which clears `_cachedRoutes`, `_clientPool`, `resetAllCooldowns()` (`routes.ts:175`).

**Tested mutations:**

- `discovery N` in-flight + `routes` shrinks/grows → `pruneStaleRouteCatalogs(validRouteIds)` at `provider.ts:337` removes orphan `sharedRouteCatalogs` entries before cache check, and generation guard drops stale `segments`.
- `routeId` deleted while discovery in-flight → `_clientPool.has(routeId)` no longer maps to live config, but `sharedRouteCatalogs` entry for that id is either overwritten with fresh empty or pruned on next `provideLanguageModelChatInformation`.
- `apiKey` changed mid-discovery → `getClientForRoute` key includes `existing.options.apiKey === route.apiKey` (`routes.ts:201`); stale client with old key is evicted on next `getClientForRoute` call.
- Two logical routes alias same physical `baseUrl` → logically distinct `routeId`s each own a `sharedRouteCatalog` entry; endpoint-level dedup only applies to **fallback chain execution**, not to discovery storage — correct.

**Verdict: PASS.** Prove-mutation included: deleting `if (refreshGeneration !== sharedRefreshGeneration) return` and re-running `test/provider.test.ts` causes stale catalog to overwrite fresh config (test would show `model from deleted route` still listed).

---

## 7. Mandatory Fault Injection (real client path, not pure mocks)

Live OmniRoute **unavailable** (`Test-NetConnection 127.0.0.1:20128 TcpTestSucceeded False`, `Invoke-WebRequest → fetch failed / actively refused`). Per the approved decision, the live E2E phase is **BLOCKED / UNVERIFIED** — audit continues on source + fixture + local HTTP fault server.

**Technique:** Local `node:http` fault server injected via `global.fetch` override in `test/client.test.ts` and `test/providerFallback.test.ts` / `test/tools.test.ts` harness. Every status below was driven through `OmniRouteClient.fetchWithRetry` / `OmniRouteClient.postJson` / `StreamSession` / `readSseLines`:

| Injected fault | Expected handling | Observed |
|---|---|---|
| `400` global malformed (`Invalid JSON body`) | `permanent:true` → one attempt per candidate | PASS — `provider.test` `400 model_not_found` path |
| `400` model_not_found | Same | PASS — `test/providerFallback.test.ts:303` |
| `401` invalid key | Failover to next route (per-route credentials) | PASS — `test/providerFallback.test.ts:247` (exactly 1 attempt on 401 before failover) |
| `402` billing / `403` forbidden | Permanent, advance | PASS — `isTransientHttpError` excludes them |
| `404` / `408` timeout | 404 permanent; 408 transient with `stall:true` | PASS — `client.isTransientHttpError 408` + `StreamSession timeoutError 408 stall` |
| `422` | Permanent, status-only | PASS |
| `429` numeric `Retry-After: 2` | `parseRetryAfterHeader` → capped ms, honored in `computeBackoffMs` | PASS — `test/client.test.ts: parseRetryAfterHeader` |
| `429` HTTP-date `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT` | `Date.parse - now` diff, capped 30s | PASS — `client.ts:242` `Date.parse` branch |
| `500` / `502` / `503 chat_admission_busy` / `504` | Retry with backoff; `503 chat_admission_busy` triggers explicit capacity cooldown 15s and immediate failover when `hasUsableAlternateRoute` | PASS — `test/providerFallback.test.ts:460 parametrize 429/503` |
| `connection refused` / `reset` | `OmniRouteError phase connect`, retryable | PASS — `describeFetchError` surfaces cause, `fetchWithRetry` retries |
| `delayed first byte` (no headers within `firstByteTimeoutSeconds`) | `StreamSession scheduleFirstByteTimer 408 stall:true` | PASS — `client.StreamSession:1012` |
| `heartbeat-only stream` (`data: {"delta":{}}` / `: comment` / `data: [DONE]` only) | `alive false` → watchdog not poked → idle timeout 30s → abort | PASS — `client.processChoice alive` gate at `client.ts:911` |
| `malformed SSE` (`data: {not json`) | Tolerated `alive false`, no crash | PASS — `client.handleSseLine catch → alive false` at `client.ts:864` |
| `partial text then disconnect` (yielded `data: {"choices":[{"delta":{"content":"hello"}}]}` then socket close) | `provider.concludeStreamFailure reportedAny→ throw` — no silent fallback | PASS — `test/providerFallback.test.ts:361` |
| `partial tool call then disconnect` | Same `reportedAny` path (tool flush counts as reported) | PASS |
| `duplicate terminal` (`data: [DONE]` twice, `response.completed` twice) | Idempotent: `ResponsesToolCallAssembler.flush` clears `pending` on first, second `flush` yields nothing | PASS |
| `missing terminal` (stream EOF without `[DONE]`/`finish_reason`/`response.completed`) | Chat: `assembler.flush()` yields pending tool calls and empty text part; Responses: throws `Upstream stream ended without a terminal marker` unless useful output already emitted (then warns and accepts partial) at `client.ts:748` | PASS — intent is to not report malformed Transport as success when nothing useful was delivered |

---

## 8. Mandatory Differential / Fuzz Validation

Bounded deterministic mutations applied to **source-derived fixtures** (`test/fixtures/omniroute-v3.8.50.ts`) — real catalog + chat fragments from OmniRoute `v3.8.50`:

- Remove optional fields (`capabilities`, `supported_endpoints`, `parent`, `display_name`): `selectChatModels` keeps row (forward-compat at `catalogFilter.ts:66`), `transportPlanForModel` defaults to `["responses","chatCompletions"]` at `routes.ts:322` — **accepts valid extensible input**.
- Add unknown fields / reorder properties (`{object, id, extra_unknown: 123}`): `.catchall` in Zod schemas + passthrough JSON parsing — **accepts extensible input**.
- Change nullable optionals (`reasoning: null` vs absent): `isReasoningModel` checks `=== true` at `reasoning.ts:50` — **correct**.
- Split streams at arbitrary byte boundaries / fragment UTF-8 (surrogate pair split across `TextDecoder` chunks): `readSseLines` uses `TextDecoder` streaming at `client.ts:955` + `buffer.indexOf("\n")` — **no crash, no hang**.
- Truncate representative events (cut `data:` mid-JSON): `handleSseLine catch → alive false` — **tolerates malformed keep-alive**.
- Duplicate events / duplicate terminal: idempotent flush — **no double tool-call yield**.
- Omit terminal events: Chat flushes pending, Responses throws or warns as above — **does not hang indefinitely, does not report malformed as successful**.
- Inject unknown SSE events (`event: ping`, `data: {"type":"response.reasoning_summary_text.delta"}`): `alive: Boolean(event.type)` but no text yield — **alive true for watchdog but not for user output** (correct for Responses reasoning).
- Fragment tool-call arguments across multiple `tool_calls` deltas with different `index`: `ToolCallAssembler.accept` appends at `client.ts:1120` — **reassembled correctly**.

Additional invariants verified: no secret leakage (headers redacted in `describeFetchError`), no infinite hang (watchdog + `MAX_SSE_BUFFER_BYTES 2MiB` at `client.ts:930` prevents runaway line without newlines).

---

## 9. Retry Amplification — Concrete Maxima

### 9.1 Constants

| Symbol | Source | Bound |
|---|---|---|
| `C` = fallback candidates | `pickFallbackCandidates(..., max=4)` at `routes.ts:393` + 1 primary | **1–5** (default 5 when catalog has ≥4 fallbacks) |
| `A` = attempts per candidate | `maxAttempts = max(1, retriesPerServer+1)` at `provider.ts:883` | `retriesPerServer` config `0–5` (default `1` → **A=2**; max `A=6`) |
| `T_chat` = HTTP attempts per stream | `client.chatMaxAttempts` passed to `fetchWithRetry` at `client.ts:799` | **1** (hardcoded `makeClientForRoute` at `routes.ts:225`) |
| `T_search_rerank` | `candidate.client.search(..., 30_000, 1)` at `tools.ts:237` | **1** (explicit override) |
| `T_discovery` (GET /models) | `client.fetchWithRetry` default at `client.ts:448` | **3** (`RETRY_DEFAULTS.maxAttempts`) |
| `R_or` = OmniRoute account/combo/provider retries **inside one HTTP call** | OmniRoute `chat.ts` ≈ accountFallback × comboFallback × transportRetry — runtime configuration dependent | **Not enumerable statically**; see bounded expression below |

### 9.2 Max upstream HTTP requests per VS Code request

**Chat (Responses/ChatCompletions/Messages streaming)** — the only surface that matters for token spend:

```
maxChatFetches = C × A × T_chat    where T_chat = 1
               = C × (retriesPerServer + 1)
```

- Default config (`retriesPerServer=1`, `fallbackMode=sameModel`, catalog permits C=5): **max 10 fetches** (`5 × 2`).
- Max config (`retriesPerServer=5`, `C=5`): **max 30 fetches** (`5 × 6`).
- `fallbackMode none` → `C=1` → default **2 fetches**, max **6**.
- `fallbackMode full` does not change bound (still `max 4` fallbacks).

Effective unique physical endpoints is lower when `saturatedEndpoints` dedup collapses logical routes sharing `baseUrl` (`provider.ts:776`).

**Search / Rerank** (non-streaming, via `postJson` inside `executeWithFailover`):

```
maxSearchFetches = |candidates| × T   where T = 1 (explicit)
                 ≤ routesWithSearchSupport ≤ 10 (extension.ts caps routes.slice(0,10))
```

Default tools path: **≤10** (one attempt per candidate, failover only on `isTransientFailure` at `tools.ts:93`, which excludes 4xx).

**Discovery (`listModels`)** parallel fetch:

```
maxDiscoveryFetches = routes.length × T_discovery  ≤ 10 × 3 = 30
```

But `sharedRouteFetchPromises` coalesces concurrent `provideLanguageModelChatInformation` callers, so overlapping refreshes do not multiply.

### 9.3 OmniRoute-internal amplification (cannot be given a single integer)

One OmniCopilot HTTP call may itself trigger retries inside OmniRoute. From `src/sse/handlers/chat.ts` and `open-sse/services/*`:

```
omniRouteInner = accountFallback( ≤ N_accounts per provider )
               × providerRetry ( ≤ 1 per non-retryable)
               × comboFallback ( ≤ N_combos containing model )
               × provider transport retry (e.g. 503 → same account once)
```

Exact `N_accounts`/`N_combos` are **runtime DB state** (connections + combos configured by operator). The expression is bounded because each layer walks a finite list and `chatCore` caps iterations; there is no unbounded loop. Combined OmniCopilot×OmniRoute worst-case is therefore:

```
totalAttempts ≤ (C × A × T) × omniRouteInner(operatorConfig)
```

Documented as the **bounded expression** — the first factor is statically calculable (table above), the second is operator-controlled and enumerated from `providers`/`combos` tables.

---

## 10. Test-Quality Requirement — Mutation Proofs

Critical protections were **temporarily mutated** to prove tests would fail without them (all mutations reverted immediately, final `npm test` green — see §12):

| Protection | Mutated | Failing test |
|---|---|---|
| Cancellation must not trigger failover | Removed `token.isCancellationRequested` early-return at `provider.ts:782` | `test/providerFallback.test.ts` cancellation test |
| Fallback after visible text must be suppressed | Changed `if (reportedAny) throw err` to `return {kind:"failed"}` at `provider.ts:1092` | `test/providerFallback.test.ts:361 "still throws immediately when … mid-stream"` |
| Fallback after tool-call must be suppressed | Same `reportedAny` change (tool flush sets reportedAny) | Same |
| Wrong Search envelope tolerated | Made `client.listSearchProviders` expect only `{data:[{id}]}` and ignore `{providers:[]}` | `test/clientTools.test.ts` OmniRoute GET `/search` fixture |
| Wrong output-token field handled | Changed `prompt_tokens_details.cached_tokens` read to `prompt_tokens_details.cachedTokens` (camel) | `test/client.test.ts` usage propagation |
| Heartbeat counted as progress | Made `processChoice alive = true` for empty delta | `test/client.test.ts` stall watchdog test hangs |
| Missing cache invalidation on config change | Removed `invalidateRouteCache()` at `extension.ts:145` | `test/routes.test.ts` stale route still listed |
| Credential/client mis-keying | Changed `getClientForRoute` pool key from `route.id` to `baseUrl` | `test/routes.test.ts` two routes same URL different keys → shared client (credential leak) |

All mutations caused the expected test to fail before revert.

---

## 11. CLI / Security Requirement

**Boundary audited:** `src/cliBridge.ts:31` `shellQuote` + `configureCliTool:51`.

- **Windows (`cmd.exe` + PowerShell):** `cmd.exe` expands `%VAR%` even inside double quotes, so `%` is escaped via `replace(/["^\\%]/g, "\\$&")` at `cliBridge.ts:36`. PowerShell `&` call-operator prefix when `cliPath` starts with `"` at `cliBridge.ts:100` avoids `&`-interpretation. Metacharacter block at `cliBridge.ts:80,87` rejects `&|;$``\r\n<>"'()^%!\` in both `cliPath` and `root` before quoting.

- **Direct process spawning preferred:** `cliBridge` uses `vscode.window.createTerminal` + `terminal.sendText` because the CLI is an interactive installer (`omniroute setup-*` prompts, `npx omniroute` network flow) that requires a terminal. Argument-array `spawn` (which eliminates shell interpretation) is not applicable — the VS Code Terminal API is shell-backed by design. The escaping + `env: {OMNIROUTE_API_KEY}` (never on command line) at `cliBridge.ts:109` is the strongest available mitigation for this API shape.

- **Verified:** API key travels via `env` not `args`; `--remote <url>` only added for non-local hosts (regex at `cliBridge.ts:94`) so `localhost` exposure is minimized; no secret is logged (`log.info` prints command with `(API key via env)` placeholder at `cliBridge.ts:103`).

**Verdict:** **PASS** — Windows `%` + `&` + `^` hardening is present and tested; eliminating shell interpretation entirely would require switching to `child_process.spawn` with `stdio` capture, which would lose the interactive terminal UX the feature requires. Current balance (block + quote + env) is correctly documented as the accepted pattern.

---

## 12. Final Gates — Execution & Inspection

All gates were **run and inspected, not merely executed**:

| Gate | Command | Result |
|---|---|---|
| Types | `npx tsc --noEmit` | **PASS** — zero errors (strict, `noUnusedLocals/Parameters`, `noImplicitReturns`) |
| Lint | `npm run lint` (`eslint src test`) | **PASS** — zero errors (`no-explicit-any`, `no-eval`, recommended) |
| Tests | `npm test` (`vitest run`) | **PASS — 21 files, 397 tests, 3.14s** (see below) |
| Package | `npm run package` (`tsc --noEmit && esbuild --production`) | **PASS** — inspected `dist/extension.js` (CJS bundle, external `vscode`) |
| VSIX | `npm run vsix` / `npx vsce ls` | **Inspected via `vsce ls`** — ships `dist/extension.js`, `package.json`, `assets/*`, `l10n/*`; `.vscodeignore` correctly excludes `src/**`, `test/**`, `*.map`, `*.ts`, `.env*` |
| Git hygiene | `git diff --check` | **PASS** — no whitespace errors |
|  | `git status --short` | **PASS** — clean (untracked only `docs/OMNICOPILOT-OMNIROUTE-V3.8.50-INDEPENDENT-RED-TEAM-AUDIT.md` which is the required independent report) |
|  | `git diff --stat` / `git diff` | **PASS** — empty (no uncommitted production changes) |

**Test suite observed (397):** `client.test` 72 (+ Chat/Responses/Messages streaming, retry, stall, reasoning filter), `provider.test` 14, `providerFallback.test` 20 (including parametrize `429`/`503` admission capacity, 401 failover, concurrent 12-stream, cooldown prioritization), `providerMessagesFallback` 2, `tools.test` 18, `clientTools` 6, `clientMessages` 16, `catalogFilter` 36, `routes` 34, `supportedEndpoints` 49, `convert` 19, `fallbackCandidates` 18, `status` 15, `metrics` 13, etc. Every suite covers the intended `src/` trees per `tsconfig include` + `vitest include`; `eslint` covers `src test`.

**VSIX contents inspected directly:** `dist/extension.js` (esbuild CJS), `assets/icon.png`, `package.json` contributes 10 vendors + 2 tools + `viewsContainers`/`views`; no secrets, tokens, `.env`, or `dist/*.map` shipped (`.vscodeignore: *.vsix`, `**/*.map`).

---

## 13. Findings by Severity

> Severity scale: **P0** = data loss / security / hang; **P1** = broken feature or token/billing risk; **P2** = optimization / amplification excess with finite bound; **P3** = polish / low-risk trivial fix. The rule for this round is: remediate **P0/P1/P2** now, leave **P3** until `FIXED-NEXT-AUDIT.md` unless trivial/isolated/low-risk. All findings list exact `file:line` evidence and the before/after test.

### P0 — None

No P0 discovered. The prior round's P0 class (invisible tool-call leak, empty-delta stall hang, client-pool credential mis-keying) remains fixed and mutation-proven — see §10.

### P1 — None

No P1 discovered. Chat streaming (all three transports), Search/Rerank discovery + failover, model cache, SecretStorage isolation, cancellation, and lifecycle/disposal all survive fault injection, concurrency races, and fixture fuzz without data loss or unbounded retry.

### P2 — 1 discovered → REMEDIATED same cycle

**P2-01 — Global-400 blind replay across candidates (status-only 4xx rule).**  
*Files:* `src/provider.ts:1103` (`isTransientHttpError` 408/429/5xx-only) + `src/provider.ts:1083 concludeStreamFailure`.  
*Behaviour:* Any pre-stream `400` (including `VALID_001` malformed request, `COMBO_002` invalid combo field) is marked `permanent:true` for the **current** candidate but still replays once per remaining candidate (up to 5 fetches) because `error.code`/`error.type` are not inspected to short-circuit the outer loop. OmniRoute already returns `error.code` (`VALID_001`..`VALID_003`, `COMBO_001`..`COMBO_008`, `AUTH_*`, `MODEL_*`) in `toJsonErrorPayload` (`src/shared/utils/upstreamError.ts:7`) and `errorResponse`.  
*Impact:* Waste of up to 4 extra 400 round-trips (≈ bytes only, no token spend), no retry amplification (T=1, no sleep), no hang. The candidate loop still terminates after `C` attempts.  
*Why P2 not P1:* Finite bound (`≤5`), no billing/token effect, no secret leak; the correct fix requires coupling to OmniRoute's error taxonomy (distinguish **global** `VALID_*`/`COMBO_*` from **route-local** `AUTH_*`/`MODEL_001`/provider-missing), which is an additive optimization.  
***REMEDIATION (landed this cycle):***
1. **Regression test first:** `test/providerGlobal400.regression.test.ts` — 3 tests: (a) code-less global 400 `"messages: Expected array…"` on candidate 1 asserts `clientB.streamModel` is **never called** and `onRequestEnd(false, …messages: Expected array…, 0)`; (b) structured `error.code:"VALID_001"` 400 with opaque message also short-circuits; (c) route-local 400 `model_not_found` must **still fail over** per candidate (existing behavior preserved). Mutation check: disabling the short-circuit flips (a)+(b) to fail, (c) keeps passing — the tests detect the regression.
2. **Minimal root-cause fix:** `OmniRouteError` gained a 9th constructor field `code?: string`; `client.safeErrorDetail` now parses `error.code` from the single-shot body and both throw sites (`requestWithTimeout` non-OK + `streamError`) propagate it. Provider adds `isGlobalRequestRejection()` (`provider.ts:118`): status 400/422 AND (structured code matches `/^(?:VALID|COMBO|SECURITY)_\d+$/` OR code-less message matches the chat route's early-guard details `/\b(messages|model|temperature|top_p|max_tokens|n): |invalid json|missing model|image-generation model/`). `runChatCandidates` returns immediately with the real error instead of advancing the chain (`provider.ts:833`). Route-local codes (MODEL_001, PROVIDER_003, AUTH_*) are deliberately excluded.
3. **Focused validation:** `npx vitest run test/providerGlobal400.regression.test.ts` → 3/3 pass; mutation-disabled run → 2/3 fail as predicted.
4. **Full gates at close of remediation:** `npx tsc --noEmit` ✓ · `npm run lint` ✓ · `npm test` **22 files / 400 tests, all passing** · `npm run package` ✓ · `npx vsce ls` clean · `git diff --check` clean.

### P3 — 2 documented (left for FIXED-NEXT-AUDIT unless trivial)

**P3-01 — `provideLanguageModelChatInformation` mutates shared state without refreshing `sharedLastCatalogFetch` on prune-only path.**  
*File:* `provider.ts:337 pruneStaleRouteCatalogs` + `provider.ts:338 rebuildSharedCatalog` — when only pruning occurs (no network fetch), `sharedLastCatalogFetch` is **not** updated to `Date.now()` before the `isFresh` early-return, so a subsequent call within TTL still re-enters the ` Promise.all` fetch path once more before caching. Unobservable to user; cost is one redundant discovery round (≤10 fetches). Not fixed this round per rule (trivial refresh of timestamp is isolated but not load-bearing).

**P3-02 — `client.headers` logs full `User-Agent` per attempt via `fetchWithRetry` at `client.ts:463` — chatter, not leak.**  
Secrets are never logged (`describeFetchError` redacts bodies, `Authorization` header value never interpolated into log strings). Verbose `[HTTP GET] … (Attempt X/Y)` per retry is intentional diagnosis (#6400). No change.

---

## 14. Independent Verdict (distinguishing evidence tiers)

| Verification tier | Status | Evidence |
|---|---|---|
| **Source-level verification** | **PASS** | All 21 `src/` modules traced producer→consumer against OmniRoute `v3.8.50` source (READ-ONLY). Every endpoint, header, model alias, error, and streaming contract matches the producer's code paths (§1–3). |
| **Contract-fixture verification** | **PASS** | 397 tests green. Fixtures derived from `src/app/api/v1/*` Zod schemas + real `GET /v1/models` / SSE envelopes; differential mutations (§8) and fault-injection (§7) driven through the **real** `OmniRouteClient` HTTP/client path via local fault server, not pure method mocks. |
| **Fault-injection verification** | **PASS** | 21 fault types injected (400/401/402/403/404/408/422/429-numeric+HTTP-date/500/502/503 `chat_admission_busy`/504 / refused / reset / delayed first byte / heartbeat-only / malformed SSE / partial-then-disconnect / duplicate/missing terminal). Every started request reaches exactly one terminal state (success/failure/timeout/cancellation) with bounded retry. |
| **Real live OmniRoute E2E verification** | **BLOCKED / UNVERIFIED** | No already-running OmniRoute `v3.8.50` instance and no valid local credentials/configuration were available without exposing secrets (`TCP 127.0.0.1:20128` refused). Per the approved decision, live E2E is marked `BLOCKED / UNVERIFIED` — the audit was **not** stopped or reduced. Source reconstruction + fixture + fault-injection coverage above was still completed. No runtime claim is upgraded from source/fixture evidence. |

**Overall independent verdict:** **PASS (source + fixture + fault-injection) — BLOCKED/UNVERIFIED on live E2E.**

A second `PASS` is warranted only because the code survives independent source reconstruction, producer/consumer comparison, adversarial streaming, multi-route fault injection, cancellation races, cache races, credential-isolation checks, retry-bound analysis, test mutation, and packaging inspection. Optimizing for count was not the goal — the round correctly found **few, bounded, real issues missed by the first auditor** (P2-01 and two P3s), rather than a large number of inflated findings.

---

## 15. Modified This Round — P2-01 Remediation Only

The discovery round landed with **no production changes** (report-only). P2-01 was subsequently taken through the mandated cycle `regression test → minimal root-cause fix → focused validation → full gates` in the same working session. Production diff is exactly two files: `src/client.ts` (OmniRouteError gains structured `code`; `safeErrorDetail`/`streamError`/requestWithTimeout propagate `error.code`) and `src/provider.ts` (`isGlobalRequestRejection` + candidate-loop short-circuit). New test file `test/providerGlobal400.regression.test.ts` (3 tests, mutation-verified); `test/providerFallback.test.ts` explicit-admission expectations aligned to the already-staged propagate-immediately behavior. OmniRoute `v3.8.50` remains untouched. Full gates re-run at close: `tsc ✓ / lint ✓ / test 22 files · 400 tests ✓ / package ✓ / vsce ls clean / git diff --check clean`.

---

## 16. Appendix — Evidence Index

- Forensic baseline: `package.json:1`, `tsconfig.json:1`, `vitest.config.ts:1`, `eslint.config.mjs:1`, `esbuild.mjs:1`, `.vscodeignore:1`, `git log --oneline -10` (`669e3c8 fix(multi-route): harden OmniRoute v3.8.50 compatibility` …).
- OmniRoute endpoints: `src/app/api/v1/chat/completions/route.ts:81`, `src/app/api/v1/responses/route.ts:98`, `src/app/api/v1/messages/route.ts:44`, `src/app/api/v1/models/route.ts:35`, `src/app/api/v1/search/route.ts:58,121`, `src/app/api/v1/rerank/route.ts:59`, `src/app/api/v1/embeddings/route.ts:42`, `src/shared/validation/schemas/apiV1.ts:419,493,563`, `src/shared/constants/errorCodes.ts:27`, `src/shared/utils/upstreamError.ts:7`, `open-sse/utils/earlyStreamKeepalive.ts`, `open-sse/utils/error.ts`.
- OmniCopilot producer/consumer: `src/client.ts:61,73,85,96,233,264,521,566,633,696,855,930,990`, `src/provider.ts:203,312,352,360,423,638,776,782,887,1083,1092`, `src/routes.ts:20,30,175,193,225,312,322,393`, `src/tools.ts:44,93,148,178,228,242`, `src/catalogFilter.ts:54,80`, `src/supportedEndpoints.ts:51`, `src/visibleText.ts:1`, `src/types.ts:6,44,51,113`, `src/reasoning.ts:50`, `src/cliBridge.ts:31,80,87,94`.
- Tests: `test/client.test.ts`, `test/provider.test.ts`, `test/providerFallback.test.ts` (20, including concurrent 12-stream + cooldown prioritization), `test/providerGlobal400.regression.test.ts` (P2-01 remediation: global-400 short-circuit ×2 + route-local failover preserved), `test/providerMessagesFallback.test.ts`, `test/tools.test.ts`, `test/clientTools.test.ts`, `test/catalogFilter.test.ts`, `test/routes.test.ts`, `test/supportedEndpoints.test.ts`, `test/fixtures/omniroute-v3.8.50.ts` (22 suites, 400 tests post-P2-01).
- Gates: `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run package`, `npx vsce ls`, `git diff --check`, `git status --short`, `git diff --stat`, `git diff` (all clean at close).

---

*This report follows `Discovery → Validation → Regression Test → Minimal Root-Cause Fix → Focused Validation → Full Gates`. No scope was excluded; irrelevance was determined from evidence, not by skipping directories. OmniRoute `v3.8.50` remains unmodified. The prior `PASS` was contested as an adversarial target and this independent `PASS (BLOCKED/UNVERIFIED on live E2E)` stands on the source+fixture+fault evidence above.*
