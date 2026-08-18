/**
 * Catalog shaping — pure helpers, split out of provider.ts so they can be unit
 * tested without a `vscode` runtime.
 *
 * Two things the raw `GET /v1/models` payload carries that the Copilot Chat
 * picker must not show:
 *
 * 1. **Non-chat models.** OmniRoute's catalog also lists specialty registries
 *    (audio, image, embedding, rerank, video, moderation). They answer on other
 *    endpoints, so picking one in chat fails on the first message.
 * 2. **Duplicate mirrors.** OmniRoute defaults to `MODELS_CATALOG_PREFIX_MODE=dual`,
 *    advertising both the short alias prefix and the canonical provider prefix
 *    (`cc/claude-sonnet-4-6` *and* `claude/claude-sonnet-4-6`) for backward
 *    compatibility. The mirror row points at the primary via `parent`.
 *    We ask for `?prefix=alias` so the server sends one id per model; this is
 *    the fallback for servers too old to honor that parameter.
 */

import type { OmniRouteModel } from "./types";

/** Surfaces OmniRoute can serve from a `/v1/chat/completions` request. It
 * translates Responses-API models transparently, so `responses` counts as
 * conversational — verified live against 192.168.0.17: `cx/gpt-5.5-low` and
 * `cx/gpt-5.6-sol-low` are listed as `supported_endpoints: ["responses"]` and
 * both answer with HTTP 200 through chat/completions. */
const CONVERSATIONAL_ENDPOINTS = new Set(["chat", "responses"]);

/**
 * Chat rows carry no `type` at all; a typed row is a specialty model, and the
 * server rejects those outright ("… is an image-generation model and cannot be
 * used on /v1/chat/completions", HTTP 400).
 *
 * `supported_endpoints` is only consulted as a backstop for an untyped row that
 * declares no conversational surface at all — filtering on "does not include
 * chat" alone would wrongly drop every Responses-API model.
 */
export function isChatModel(model: OmniRouteModel): boolean {
  const type = (model.type ?? "").trim().toLowerCase();
  if (type && type !== "chat") return false;

  const endpoints = model.supported_endpoints;
  if (Array.isArray(endpoints) && endpoints.length > 0) {
    return endpoints.some((e) => CONVERSATIONAL_ENDPOINTS.has(String(e).trim().toLowerCase()));
  }
  return true;
}

/**
 * Drop specialty models and duplicate-prefix mirrors, preserving order.
 *
 * A row is a mirror only when its `parent` names a *different* id that is also
 * present in the same response — so a `parent` pointing at an absent model (or
 * at itself) never costs us an entry.
 */
export function selectChatModels(models: readonly OmniRouteModel[]): OmniRouteModel[] {
  const listedIds = new Set<string>();
  for (const model of models) {
    if (model?.id) listedIds.add(model.id);
  }

  const out: OmniRouteModel[] = [];
  for (const model of models) {
    if (!model?.id) continue;
    if (!isChatModel(model)) continue;
    if (model.parent && model.parent !== model.id && listedIds.has(model.parent)) continue;
    out.push(model);
  }
  return out;
}
