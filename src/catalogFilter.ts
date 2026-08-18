import type { OmniRouteModel } from "./types";

/**
 * Surfaces OmniRoute can serve from a `/v1/chat/completions` request. It
 * translates Responses-API models transparently, so `responses` counts as
 * conversational — verified against Codex/GPT-5.x models.
 */
const CONVERSATIONAL_ENDPOINTS = new Set(["chat", "responses"]);

/**
 * Chat rows carry no `type` at all; a typed row is a specialty model, and the
 * server rejects those outright ("… is an image-generation model and cannot be
 * used on /v1/chat/completions", HTTP 400).
 *
 * `supported_endpoints` is only consulted as a backstop for an untyped row that
 * declares no conversational surface at all.
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
