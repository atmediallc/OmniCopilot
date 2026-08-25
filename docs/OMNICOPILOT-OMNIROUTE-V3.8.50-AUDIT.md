# OmniCopilot × OmniRoute v3.8.50 Engineering Audit

**Audit date:** 2026-08-24 (round 2: 2026-08-25)  
**OmniCopilot root:** `C:\proyectos\omnicopilot\multi-route`  
**OmniRoute evidence root:** `C:\proyectos\omniroute\v3.8.50`  
**Scope:** OmniRoute is read-only. Remediation is limited to OmniCopilot.

## 1. Executive Summary

The integration has a generally sound transport architecture: OmniCopilot separates VS Code integration, route configuration, wire conversion, streaming parsing, and fallback policy; OmniRoute normalizes provider behavior behind its chat handlers and streaming pipeline. Initial OmniCopilot validation passed 384 tests, lint, type checking, and production bundling.

A second evidence-driven pass against the v3.8.50 source identified two further P1 producer/consumer mismatches (search-provider list parsing, chain-killing pre-stream 4xx handling) and five P2 hygiene/security/performance/compatibility gaps, remediated in round 2 alongside quality-gate widening (`tsc`/`eslint` now cover `test/`) and source-derived wire-contract fixtures (`test/fixtures/omniroute-v3.8.50.ts`). No confirmed P0 was found. Current status: **PASS** (all P1/P2 findings implemented and validated).

## 2. Repository Baseline

| Repository | Branch | Commit | Initial status |
|---|---|---|---|
| OmniCopilot | `feat/multi-route` | `0747a7262d43060ea5232da01d96565236e2886b` | Clean |
| OmniRoute | `v3.8.50` | `74389b89a6659c3c368d0a5d788e9ced1aced336` | Clean; read-only |

Runtime baseline: Node.js `v24.16.0`, npm `11.13.0`, Git `2.55.0.windows.5`.

Initial OmniCopilot gates:

- `npm run lint`: PASS.
- `npm test`: PASS, 20 files and 384 tests.
- `npm run package`: PASS, including `tsc --noEmit` and production esbuild.

Initial OmniRoute narrow gates were environmentally blocked:

- `npm run typecheck:core`: `tsc` unavailable because dependencies are not installed.
- `npm run check:open-sse-typecheck`: Windows `spawnSync npx.cmd EINVAL`.

These are baseline environment failures, not failures introduced by OmniCopilot remediation.

## 3. OmniRoute Architecture

Relevant request flow established from implementation:

```text
HTTP route
  → content/body admission and Zod validation
  → authentication and API-key policy
  → model/alias/combo resolution
  → handleChat / handleSingleModelChat
  → handleChatCore
  → request translation
  → provider executor and upstream fetch
  → stream readiness
  → response/SSE translation
  → usage, accounting, error normalization, cleanup
```

Primary evidence:

- API routes: `src/app/api/v1/`.
- Chat orchestration: `src/sse/handlers/chat.ts`.
- Hot-path handler: `open-sse/handlers/chatCore.ts`.
- Translation: `open-sse/translator/index.ts`.
- Execution: `open-sse/executors/base.ts` and `open-sse/executors/index.ts`.
- Routing/fallback: `open-sse/services/combo.ts` and `open-sse/services/accountFallback.ts`.
- Streaming: `open-sse/utils/stream.ts`, `open-sse/utils/streamHandler.ts`, and `open-sse/utils/streamReadiness.ts`.
- Responses conversion: `open-sse/transformer/responsesTransformer.ts`.

## 4. OmniRoute Protocol Contract

### Models

`GET /v1/models?prefix=alias` returns an OpenAI-style `{ object: "list", data: [...] }` envelope. Rows are heterogeneous and optional metadata must remain optional. The v3.8.50 output-limit field is `max_output_tokens`; ordinary chat-only rows may omit `supported_endpoints`. Prefix modes are `alias`, `canonical`, and `dual`. Catalog authorization is evaluated before cached response resolution.

Evidence: `src/app/api/v1/models/route.ts`, `catalog.ts`, `catalogRequest.ts`, `catalogCache.ts`, and `catalogResponse.ts`.

### Chat protocols

`/v1/chat/completions`, `/v1/responses`, and `/v1/messages` converge on shared routing and provider execution. OmniRoute translates between source and target formats. Responses uses `max_output_tokens`; Anthropic Messages uses `max_tokens`.

### Streaming

OmniRoute buffers fragmented SSE, normalizes multiline data, filters incompatible keepalives, and emits protocol-specific terminal events. Normal Responses streams include `response.completed` and `[DONE]`; normal Chat Completions streams receive exactly one `[DONE]`. Stream readiness waits for a non-ping event rather than treating HTTP 200 or startup keepalives as generation progress.

### Admission and resilience

Heavy-request admission can return HTTP 503 with `error.code=chat_admission_busy` and numeric `Retry-After`. OmniRoute also owns provider circuit breaking, per-connection cooldown, model lockout, executor transport replay, account fallback, combo fallback, and optional stream recovery. External retries must therefore be tightly bounded and must never replay after meaningful text or tool output.

### Search and Rerank

Search providers are enumerated by `GET /v1/search`; Search execution uses `POST /v1/search` and can select a provider server-side. Rerank uses `POST /v1/rerank`; model metadata may be sourced through the model catalog.

## 5. OmniCopilot Architecture

```text
VS Code activation
  → provider registration per configured route
  → shared route/model discovery
  → VS Code request conversion
  → transport plan selection
  → OmniRouteClient stream
  → normalized StreamEvent
  → VS Code progress/tool-call parts
```

Key boundaries:

- Activation/lifecycle: `src/extension.ts`.
- Provider orchestration: `src/provider.ts`.
- HTTP and protocol parsing: `src/client.ts`.
- Route persistence/client pooling/fallback candidates: `src/routes.ts`.
- VS Code message conversion: `src/convert.ts`.
- Endpoint classification: `src/supportedEndpoints.ts`.
- Search/Rerank tools: `src/tools.ts`.
- Usage/metrics/status: `src/usage.ts`, `src/metrics.ts`, and `src/statusBar.ts`.

## 6. Compatibility Matrix

| Area | OmniRoute v3.8.50 behavior | OmniCopilot baseline assumption | Match | Risk / action |
|---|---|---|---|---|
| Catalog prefix | Supports `prefix=alias` | Requests alias mode | Yes | Retain |
| Catalog output limit | `max_output_tokens` | Reads `max_completion_tokens` | No | P1 fix |
| Search discovery | `GET /v1/search` | Searches `/v1/models.supported_endpoints` | No | P1 fix |
| Responses limit | `max_output_tokens` | Canonical request omits `max_tokens` | No | P1 fix |
| Messages limit | `max_tokens` | Falls back to 4096 | Partial | P1 fix |
| Empty transport | Incompatible model should not execute | Zero requests interpreted as success | No | P1 fix |
| Responses terminal | `response.completed` plus `[DONE]` | Accepts both | Yes | Contract fixture recommended |
| Search list shape | `{object:"list", data:[{id,...}]}` | Parsed bare array / `{providers}` only | No | FIXED round 2 (`COMPAT-P1-010`) |
| Model display name | Catalog emits `name` | Read only `display_name` | No | FIXED round 2 (`COMPAT-P2-015`) |
| Pre-stream 4xx | Definitive per-route rejection (e.g. 400 model_not_found) | Threw out of the whole fallback chain | No | FIXED round 2 (`MULTI-P1-011`) |
| Keep-alive frames | Empty-delta chunk / `response.in_progress` / Messages ping | Ignored by watchdog; non-terminal | Yes | Contract fixture added |
| Admission | 503 + `chat_admission_busy` + `Retry-After` | Route-aware retry/failover | Partial | Add HTTP-date support; bound retries |
| Cancellation | Request signal reaches admission/fetch/body | VS Code token reaches fetch/body reader | Yes | Add real integration proof |
| Error body | Structured, sanitized normal errors | Can expose short arbitrary plain body | Partial | Sanitize fallback |
| Route schema | Server route is local client configuration | Manifest advertises ignored policy fields | No | P1 fix |

## 7. Findings

| ID | Severity | Repository | Evidence and root cause | User impact | Proposed validation | Status |
|---|---|---|---|---|---|---|
| `COMPAT-P1-001` | P1 | OmniCopilot | `src/provider.ts` reads `max_completion_tokens`; OmniRoute `catalog.ts` emits `max_output_tokens`. | Wrong VS Code output limit and possible oversized requests. | Catalog projection and cache tests. | CONFIRMED |
| `TOOLS-P1-001` | P1 | OmniCopilot | `src/tools.ts` discovers Search through `/models`; OmniRoute `search/route.ts` exposes `GET /v1/search`. | Search tool can claim no provider exists. | Native Search discovery contract test. | CONFIRMED |
| `CONFIG-P1-001` | P1 | OmniCopilot | `package.json` advertises route policy fields absent from `RouteConfig` and load/save. | Configuration silently ignored. | Manifest schema test. | CONFIRMED |
| `STREAM-P1-001` | P1 | OmniCopilot | `client.streamModel()` accepts `[]` and yields nothing; provider interprets completion. | Incompatible model produces an empty successful response. | No-fetch rejection test. | CONFIRMED |
| `COMPAT-P1-002` | P1 | OmniCopilot | `buildChatRequest()` omits selected output budget. | Responses omits its limit; Messages is restricted to 4096. | Exact serialized-body tests. | CONFIRMED |
| `CONFIG-P2-001` | P2 | OmniCopilot | `firstByteTimeoutSeconds` is read but absent from manifest. | Setting unavailable in normal VS Code configuration. | Manifest bounds test. | CONFIRMED |
| `PERF-P2-001` | P2 | OmniCopilot | Fixed tools rediscover every configured route on every invocation. | Avoidable latency and server load. | Sequential/concurrent cache test. | CONFIRMED |
| `RETRY-P2-001` | P2 | OmniCopilot | Specialty HTTP retries multiply candidate and OmniRoute fallback. | Retry storms and duplicated load. | Request-count test. | CONFIRMED |
| `HTTP-P2-001` | P2 | OmniCopilot | `Retry-After` parser accepts numbers only. | HTTP-date hints ignored. | Seconds/date/past-date tests. | CONFIRMED |
| `SEC-P3-001` | P3 | OmniCopilot | Unstructured upstream bodies may be surfaced verbatim in `safeErrorDetail`. | Short secret/path leakage from a malicious proxy. | Secret/path/HTML redaction tests. | CONFIRMED |
| `COMPAT-P1-010` | P1 | OmniCopilot | `listSearchProviders()` (`src/client.ts`) parsed only bare-array / `{providers:[]}` shapes; v3.8.50 `GET /v1/search` returns `{object:"list", data:[{id, object:"search_provider", ...}]}` (`src/app/api/v1/search/route.ts:58-75`). | Tool discovery always saw zero providers against real OmniRoute → `omniroute_search` degraded to `/models` scan. | Wire-shape fixture test in `test/clientTools.test.ts` + contract test in `test/contract.omniroute.test.ts`. | FIXED (round 2) |
| `MULTI-P1-011` | P1 | OmniCopilot | `concludeStreamFailure()` threw on any pre-stream non-transient status; one route's 401/402/403/400 aborted the entire multi-route chain despite per-route SecretStorage keys. | A single misconfigured route (bad key, unknown model alias) killed requests that another configured route could have served. | Regression tests in `test/providerFallback.test.ts`: 401 fail-over, 400 model_not_found exhaustion surfacing last error, mid-stream failure still fatal. | FIXED (round 2) |
| `HYGIENE-P2-012` | P2 | OmniCopilot | Uncommitted `.gitignore` hunk ignored all of `docs/`, leaving the audit report unversioned. | Audit trail not tracked in git. | `git status` shows the report as trackable after revert. | FIXED (round 2) |
| `SEC-P2-013` | P2 | OmniCopilot | `cliBridge.shellQuote()` did not escape `%`; cmd.exe expands `%VAR%` inside double quotes. `baseUrl`-derived URL reached the shell unvalidated. | A crafted stored route URL could inject environment-variable content into the terminal command. | `%` now escaped in win32 quoting path; root URL validated against shell metacharacters before use. | FIXED (round 2) |
| `PERF-P2-014` | P2 | OmniCopilot | 60s tool-discovery cache held stale clients after route config changes; `clearToolDiscoveryCache()` existed but nothing called it. | Requests could keep flowing through a removed/edited server for up to 60s. | Cache invalidation wired into the `omnicopilot` configuration-change listener in `extension.ts`. | FIXED (round 2) |
| `COMPAT-P2-015` | P2 | OmniCopilot | Extension read only `display_name`; v3.8.50 catalog rows carry their display label in `name` (`catalog.ts` syncedFields). | Model picker showed raw provider ids instead of friendly names. | Added `name?: string` to `OmniRouteModel`; resolution order now `display_name ?? name ?? id`. | FIXED (round 2) |
| `RETRY-P2-016` | P2 | OmniCopilot | Worst-case retry amplification undocumented. | Operators could not reason about load under outage. | Budget documented in §10. | DOCUMENTED (round 2) |
| `TEST-P2-017` | P2 | OmniCopilot | Tests excluded from `tsc --noEmit` and eslint; several latent type errors (wrong StreamEvent kinds, missing tooltip fields, untyped package.json import). | Test code could silently drift from source types. | Gates widened (`tsconfig.json` includes `test/**`, lint script covers `src test`); violations fixed; suite grew to 397 tests incl. contract fixtures. | FIXED (round 2) |

### Round-2 P3 notes (accepted, no action required)

- Dead `vendorForRoute()` helper removed from analysis; no dead code remained after round-1 refactors.
- `listSearchProviders(undefined, timeout)` ignores its cancellation token — acceptable: bounded by a 5s timeout and called only outside request scope.
- Mojibake comments in two files are cosmetic; left untouched to keep the diff reviewable.
- `reportActivity(baseUrl:"")` inconsistency is display-only in status tooltip provenance; retained intentionally for local-route labeling.

## 8. Hardcoded Assumptions

| Assumption | Classification | Action |
|---|---|---|
| Default OmniRoute port `20128` | Intentional product default | Retain, configurable through route URL |
| API prefix `/v1` | Stable audited contract | Retain normalization |
| First-byte default 120 seconds | Valid but undeclared configuration | Declare |
| Stream-idle default 30 seconds | Client safety default | Document and reassess configurability |
| Messages fallback 4096 | Emergency compatibility default | Retain only when no selected limit exists |
| Ten active routes | VS Code/provider-slot product limit | Document residual limit |
| Maximum fallback candidates | Client policy | Review against retry amplification |

## 9. Streaming Analysis

OmniCopilot's `readSseLines()` uses incremental `TextDecoder`, handles CRLF, fragmented network chunks, multiple events per chunk, and bounded no-newline buffering. Protocol parsers assemble fragmented tool arguments and usage events. Fallback is prohibited after visible text/tool output, which avoids duplicated UI output and tool execution.

Responses termination is compatible with OmniRoute v3.8.50. Remaining policy risk: useful partial text may be accepted after missing terminal completion, while an empty stream is rejected. This behavior must stay explicit and covered.

## 10. Multi-Route Analysis

OmniCopilot routes are distinct OmniRoute server endpoints. Client-side fallback is separate from OmniRoute's internal provider/combo fallback. Saturation is tracked by normalized physical endpoint so route aliases do not create fake capacity. Explicit admission failure retries the selected model only when no alternate physical endpoint remains; otherwise it fails over immediately.

Since round 2, candidate-level classification distinguishes:

- **Fatal (throw immediately):** user cancellation; any failure after meaningful output was emitted (VS Code already rendered tokens/tool calls — replay would duplicate them).
- **Permanent for the candidate, chain advances:** pre-stream 4xx rejections (401 auth, 402 billing, 403 permission, 400 model resolution, 404, 422). Retrying the same route cannot help; per-route credentials mean another route can still serve. No cooldown/backoff is consumed.
- **Transient (bounded retry then advance):** network failures and 408/429/5xx with stall/throttle flags.

Residual amplification budget:

```text
worst case ≈ candidates × (1 + retriesPerServer) client attempts
             × OmniRoute internal retries (≈5) × combo fan-out
```

Chat streams use `chatMaxAttempts: 1` (`src/routes.ts makeClientForRoute`), so OmniCopilot never multiplies attempts on the chat path beyond its own candidate loop; fixed tools pass `maxAttempts: 1` explicitly. No replay is permitted after meaningful stream output.

## 11. Security Findings

No confirmed P0/P1 security defect was identified. API keys use VS Code SecretStorage and Authorization header values are normalized against CR/LF injection. `SEC-P3-001` remains open for unstructured non-OmniRoute error bodies. OmniRoute is treated as an external trust boundary even when hosted locally.

## 12. Performance Findings

`PERF-P2-001` and `RETRY-P2-001` are evidence-backed. Chat discovery already coalesces in-flight requests and retains last-known route catalogs. Fixed tools currently do not reuse that behavior and can add up to ten catalog requests before each execution.

## 13. Testing Gaps

- Exact OmniRoute Responses wire fixture (`response.completed`, usage, `[DONE]`).
- Real cancellation propagation into an OmniRoute upstream executor.
- Search discovery fixture from `GET /v1/search`.
- Empty transport false-success regression.
- Retry amplification request counts.
- Same-endpoint route-alias saturation regression.
- Malicious unstructured error-body sanitization.
- Extension-host activation/deactivation and disposal E2E.

## 14. Remediation Plan

1. P1 output-token metadata and request propagation.
2. P1 native Search discovery.
3. P1 empty transport rejection.
4. P1 honest route configuration schema and P2 timeout declaration.
5. P2 tool discovery cache/coalescing.
6. P2 specialty retry ownership.
7. P2 Retry-After parsing and P3 error sanitation.
8. Full lint, type, tests, production bundle, VSIX, and diff audit.

## 15. Implemented Fixes

1. **Output token limits & request propagation (`P1`):** Added `max_output_tokens` support in `types.ts`, `provider.ts`, and client request building; regression tested in `test/provider.test.ts`.
2. **Native Search provider discovery (`P1`):** Added `OmniRouteClient.listSearchProviders()` (`GET /v1/search`) and aligned tool discovery in `src/tools.ts`; covered in `test/clientTools.test.ts` and `test/tools.test.ts`.
3. **Empty transport plan rejection (`P1`):** `streamModel()` throws compatibility error when `transportPlan.length === 0` instead of false success; verified in `test/client.test.ts`.
4. **Clean route schema & configuration (`P1`/`P2`):** Removed unsupported properties (`apiKey`, `models`, `excludeModels`, `prefix`, `priority`, `weight`) from `package.json` route schema; declared `firstByteTimeoutSeconds` in configuration and localization bundles.
5. **Tool discovery cache & coalescing (`P2`):** Added TTL-based cache and in-flight promise coalescing to `candidatesFor()` with `clearToolDiscoveryCache()` export.
6. **Tool retry ownership (`P2`):** Fixed tools pass `maxAttempts = 1` for Search and Rerank calls, delegating outer failover to candidate iteration without multiplying upstream attempts.
7. **HTTP-date Retry-After & error sanitization (`P2`/`P3`):** Implemented delta-seconds and RFC 7231 HTTP-date `Retry-After` parsing with 30s cap, alongside HTML/control-character sanitization and length bounding in `safeErrorDetail()`.
8. **Search-provider list shape (`COMPAT-P1-010`, round 2):** `listSearchProviders()` now parses the v3.8.50 `{object:"list", data:[{id}]}` envelope (legacy bare-array / `{providers:[]}` retained for other OpenAI-compatible servers); covered by wire-shape tests.
9. **Candidate-level failure classification (`MULTI-P1-011`, round 2):** pre-stream 4xx marks the attempt `permanent` — `tryCandidate()` breaks its retry loop immediately and `runChatCandidates()` advances to the next route; cancellation and mid-stream failures remain fatal. Regression-tested.
10. **Hygiene/security/perf batch (round 2):** `docs/` un-ignored; `%` escaped in win32 shell quoting + root URL metacharacter validation in `cliBridge.ts`; `clearToolDiscoveryCache()` wired into config-change handling; `OmniRouteModel.name` display fallback added.
11. **Quality gates widened (`TEST-P2-017`, round 2):** `tsc --noEmit` and eslint now cover `test/`; surfaced type errors fixed (`toolCall` event kinds, tooltip totals, typed manifest import).
12. **Source-derived contract fixtures (round 2):** `test/fixtures/omniroute-v3.8.50.ts` encodes audited v3.8.50 wire shapes (search list, catalog rows incl. specialty exclusion, keep-alive/heartbeat/ping frames, terminal markers, model_not_found body) with source citations; `test/contract.omniroute.test.ts` asserts OmniCopilot's parsers consume them.
13. **VSIX hygiene (round 2):** `.vscodeignore` now excludes `docs/**` so internal engineering material no longer ships in the package.

## 16. Validation Results

Round 1:

- **Unit test suite:** 388/388 Vitest tests passing across 20 test files (`npx vitest run`).
- **TypeScript typecheck:** Clean compilation (`npm run check-types` / `tsc --noEmit`, src-only).
- **ESLint:** Clean lint across workspace (src-only at the time).
- **Production packaging:** Clean esbuild bundle creation (`npm run package`).
- **VSIX packaging:** Clean `.vsix` artifact generation (`npm run vsix`).
- **OmniRoute repository status:** Clean read-only state maintained without changes.

Round 2 (final):

- **TypeScript typecheck:** `tsc --noEmit` exit 0 — now covering `src/` **and** `test/`.
- **ESLint:** `eslint src test` clean.
- **Unit test suite:** **397/397** Vitest tests passing across **21** files, including new P1-A/P1-B regressions and the v3.8.50 contract suite.
- **Production packaging:** `npm run package` (check-types + production esbuild) exit 0.
- **VSIX content audit:** `vsce ls` shows no `docs/`, `src/`, `test/`, `.env`, or map files in the package.
- **Git hygiene:** `.gitignore` no longer excludes `docs/`; audit report versioned; OmniRoute repo untouched.

## 17. Residual Risks

- OmniRoute's local dependencies were kept read-only; its own internal test gates were not run locally.
- Upstream live provider performance depends on deployed instance latency and provider credentials.
- Client-side failover relies on accurate endpoint readiness and network responsiveness.

## 18. Final Acceptance Assessment

**PASS** — All identified P1 and P2 compatibility defects between OmniCopilot and OmniRoute v3.8.50 — including the round-2 findings `COMPAT-P1-010` (search list shape) and `MULTI-P1-011` (chain-killing pre-stream 4xx) and the P2 batch (`HYGIENE-P2-012`, `SEC-P2-013`, `PERF-P2-014`, `COMPAT-P2-015`, `RETRY-P2-016`, `TEST-P2-017`) — have been remediated with focused regression tests, source-derived wire-contract fixtures, a widened quality-gate scope covering tests, full test suite pass (397/397), zero type/lint errors, clean packaging with a leak-free VSIX manifest, and untouched read-only state in OmniRoute.

Live end-to-end integration against a running OmniRoute v3.8.50 server was intentionally deferred (user decision); wire fidelity is instead pinned by the source-derived fixtures in `test/fixtures/omniroute-v3.8.50.ts`, which should be re-validated against a live instance when one is available.
