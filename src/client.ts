import * as crypto from "node:crypto";
import { isFramingAllowed } from "./embed";
import type {
  ChatRequest,
  ModelsResponse,
  OmniRouteModel,
  StreamChunk,
  StreamDelta,
  StreamEvent,
  StreamToolCallDelta,
} from "./types";

/** Backoff/retry knobs. Defaults target transient admission/rate-limit
 * failures (429/5xx); permanent client errors (4xx) are never retried. */
export interface RetryPolicy {
  /** Total HTTP attempts including the first. Default 3. */
  maxAttempts?: number;
  /** Exponential backoff base in ms. Default 400. */
  baseMs?: number;
  /** Per-attempt delay cap in ms. Default 4000. */
  maxMs?: number;
}

export interface OmniLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug?(message: string, ...args: unknown[]): void;
}

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
  retry?: RetryPolicy;
  /** Chat HTTP attempts. Keep at 1 when the provider owns cross-server retry. */
  chatMaxAttempts?: number;
  log?: OmniLogger;
  /** Abort a streaming response if no byte arrives within this long (ms).
   * Guards against dead proxies that accept the connection and never send
    * headers/body. Default 120000. */
  streamFirstByteTimeoutMs?: number;
  /** Abort a streaming response that sends no further data for this long (ms)
   * once streaming has started. Default 30000. */
  streamIdleTimeoutMs?: number;
}

const USER_AGENT = "OmniCopilot-VSCode";

function headers(apiKey: string | undefined, json: boolean, isStream = false): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": USER_AGENT,
    "Connection": "keep-alive",
    "Accept": isStream ? "text/event-stream, application/json" : "application/json",
  };
  if (json) h["Content-Type"] = "application/json";
  if (apiKey) {
    const cleanKey = apiKey.replace(/[\r\n]/g, "").trim();
    if (cleanKey) h["Authorization"] = `Bearer ${cleanKey}`;
  }
  return h;
}

export const DEFAULT_BASE_URL = "http://127.0.0.1:20128";

/** Normalize a user-supplied base URL: trim, drop trailing slashes, ensure /v1. */
export function normalizeBaseUrl(raw: string): string {
  let url = (raw || "").trim();
  while (url.endsWith("/")) url = url.slice(0, -1);
  if (!url) return `${DEFAULT_BASE_URL}/v1`;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  if (!/\/v1$/i.test(url)) url = `${url}/v1`;
  url = url.replace(/:\/\/(localhost|0\.0\.0\.0|\[::1\])/i, "://127.0.0.1");
  return url;
}

/** Base URL without the /v1 suffix (dashboard, CLI --remote flag). */
export function serverRootUrl(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl).replace(/\/v1$/i, "");
}

/** Error carrying the upstream HTTP status, so callers can tell transient
 * server-side failures (retry/fallback) apart from permanent ones. */
export class OmniRouteError extends Error {
  constructor(
    message: string,
    /** HTTP status when the failure came from an upstream response. */
    public readonly status?: number,
    /** True when the stream stalled (no SSE within the timeout window).
     * The upstream is alive and processing the same request, so re-sending it
     * would just burn tokens again — callers should NOT retry the server. */
    public readonly stall = false,
    /** Where the failure happened: connecting, receiving headers,
     * mid-stream, or reported by the upstream. */
    public readonly phase?: "connect" | "headers" | "stream" | "provider",
    /** Upstream endpoint that failed, e.g. /models or /chat/completions. */
    public readonly endpoint?: string,
    /** Milliseconds the failed attempt took (status-bar diagnosis). */
    public readonly latencyMs?: number,
    /** Suggested wait from the upstream's `Retry-After` header (503/429),
     * in milliseconds — lets the caller's backoff honor it. */
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "OmniRouteError";
  }
}

/** Node's fetch (undici) throws an opaque `TypeError: fetch failed` and stashes
 * the real reason — DNS failure (`ENOTFOUND`), connection refused
 * (`ECONNREFUSED`), timeout (`ETIMEDOUT`), TLS error, dead SOCKS proxy — on
 * `error.cause`. Surface that cause so users see *why* a server is offline
 * instead of a bare "fetch failed". Guards against cyclic cause chains. */
export function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return formatErrorValue(error);
  let msg = error.message;
  let current: unknown = error;
  const seen = new Set<Error>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const cause = (current as { cause?: unknown }).cause;
    if (!(cause instanceof Error) || seen.has(cause) || current.message.includes(cause.message)) {
      break;
    }
    msg = `${msg}: ${cause.message}`;
    current = cause;
  }
  return msg;
}

/** Best-effort human-readable rendering of an unknown thrown value. Errors
 * and strings keep their normal stringification; other objects get their JSON
 * form instead of the useless "[object Object]". */
export function formatErrorValue(err: unknown): string {
  if (err instanceof Error || typeof err === "string") return String(err);
  if (err === undefined || err === null || typeof err !== "object") return String(err);
  try {
    return JSON.stringify(err) ?? "[unserializable object]";
  } catch {
    // Circular or un-serializable object — stable placeholder instead of the
    // useless "[object Object]".
    return "[unserializable object]";
  }
}

/** Statuses worth retrying: request timeout, rate limit, and 5xx range. */
export function isTransientHttpError(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 504);
}

/** Detects upstream rate limits, capacity constraints, quota issues, or concurrency limits. */
export function isThrottleError(err: unknown): boolean {
  if (err instanceof OmniRouteError) {
    if (err.status === 429 || err.status === 503) return true;
    const msg = err.message.toLowerCase();
    return (
      msg.includes("rate limit") ||
      msg.includes("ratelimit") ||
      msg.includes("concurrency") ||
      msg.includes("concurrent") ||
      msg.includes("overloaded") ||
      msg.includes("busy") ||
      msg.includes("resource_exhausted") ||
      msg.includes("resource has been exhausted") ||
      msg.includes("quota") ||
      msg.includes("too many requests") ||
      msg.includes("throttled") ||
      msg.includes("try again") ||
      msg.includes("capacity")
    );
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes("429") ||
      msg.includes("503") ||
      msg.includes("rate limit") ||
      msg.includes("ratelimit") ||
      msg.includes("concurrency") ||
      msg.includes("concurrent") ||
      msg.includes("overloaded") ||
      msg.includes("busy") ||
      msg.includes("resource_exhausted") ||
      msg.includes("quota") ||
      msg.includes("throttled")
    );
  }
  return false;
}

const RETRY_DEFAULTS: Required<RetryPolicy> = { maxAttempts: 3, baseMs: 400, maxMs: 4000 };

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new Error("The operation was aborted");
}

/** Abortable delay: resolves after `ms` unless the signal aborts first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortReason(signal));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Backoff for a failed attempt: honor Retry-After, else exponential + jitter. */
function retryDelayMs(res: Response | undefined, attempt: number, policy: Required<RetryPolicy>): number {
  if (res) {
    const retryAfter = Number(res.headers.get("retry-after"));
    // Honor the server's hint, but cap it: a pathological/hostile value
    // (e.g. HTTP-date or huge integer) must not stall the request for minutes.
    if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(retryAfter * 1000, 30_000);
  }
  const base = Math.min(policy.maxMs, policy.baseMs * 2 ** attempt);
  // crypto.randomInt (CSPRNG) rather than Math.random: the jitter is not
  // security-relevant, but this keeps implementations of jitter consistent.
  const jitter = crypto.randomInt(Math.min(base, 200) + 1);
  return Math.min(policy.maxMs, base + jitter);
}

/** @deprecated Superseded by `pickFallbackCandidates` in routes.ts for multi-route fallback.
 * Kept for backward-compatible test coverage. */
export function pickFallbackModels(
  primaryId: string,
  models: OmniRouteModel[],
  needsTools: boolean,
  max = 2
): OmniRouteModel[] {
  const family = primaryId.split("/")[0];
  const compatible = (m: OmniRouteModel) =>
    m.id !== primaryId && (!needsTools || m.capabilities?.tool_calling !== false);
  const sameFamily = models.filter((m) => compatible(m) && m.id.split("/")[0] === family);
  const pool = sameFamily.length > 0 ? sameFamily : models.filter(compatible);
  return pool.slice(0, max);
}

/** Thin HTTP client for an OmniRoute (or any OpenAI-compatible) server. */
export class OmniRouteClient {
  constructor(private readonly opts: ClientOptions) {}

  get baseUrl(): string {
    return normalizeBaseUrl(this.opts.baseUrl);
  }

  /** Fast availability probe. OmniRoute serves HEAD /v1/models explicitly. */
  async ping(timeoutMs = 3000): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      let res = await fetch(`${this.baseUrl}/models`, {
        method: "HEAD",
        headers: headers(this.opts.apiKey, false),
        signal: ctrl.signal,
        keepalive: true,
      });
      if (res.status === 405 || res.status === 404 || res.status === 501) {
        res = await fetch(`${this.baseUrl}/models`, {
          method: "GET",
          headers: headers(this.opts.apiKey, false),
          signal: ctrl.signal,
          keepalive: true,
        });
      }
      const ok = res.ok || (res.status >= 400 && res.status < 500);
      const elapsed = Date.now() - t0;
      this.opts.log?.info(`[PING] ${this.baseUrl} -> ${ok ? "ONLINE" : "OFFLINE"} (HTTP ${res.status}, ${elapsed}ms)`);
      return ok;
    } catch (err) {
      const elapsed = Date.now() - t0;
      this.opts.log?.warn(`[PING FAILED] ${this.baseUrl} -> OFFLINE (${elapsed}ms): ${formatErrorValue(err)}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Whether the dashboard may be framed by the VS Code Simple Browser.
   * Fails closed: an unreachable server is not embeddable either. */
  async canEmbedDashboard(timeoutMs = 4000): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(serverRootUrl(this.baseUrl), {
        method: "HEAD",
        redirect: "manual",
        headers: headers(this.opts.apiKey, false),
        signal: ctrl.signal,
      });
      return isFramingAllowed(res.headers);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** fetch that retries transient failures (429/5xx) with exponential backoff,
   * honoring the server's Retry-After header when present. The abort signal is
   * read from `init.signal` (the shape fetch itself expects) so in-flight
   * requests abort and inter-attempt sleeps are cancellable. */
  private async fetchWithRetry(url: string, init: RequestInit, maxAttemptsOverride?: number): Promise<Response> {
    const signal = init.signal ?? new AbortController().signal;
    const maxAttempts = Math.max(
      1,
      maxAttemptsOverride ?? this.opts.retry?.maxAttempts ?? RETRY_DEFAULTS.maxAttempts
    );
    const policy: Required<RetryPolicy> = {
      maxAttempts,
      baseMs: this.opts.retry?.baseMs ?? RETRY_DEFAULTS.baseMs,
      maxMs: this.opts.retry?.maxMs ?? RETRY_DEFAULTS.maxMs,
    };
    const method = init.method ?? "GET";
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw abortReason(signal);
      const attemptT0 = Date.now();
      let res: Response;
      try {
        this.opts.log?.info(`[HTTP ${method}] ${url} (Attempt ${attempt + 1}/${maxAttempts})`);
        res = await fetch(url, init);
        const elapsed = Date.now() - attemptT0;
        this.opts.log?.info(`[HTTP ${method}] ${url} -> ${res.status} ${res.statusText} (${elapsed}ms)`);
      } catch (err) {
        const elapsed = Date.now() - attemptT0;
        if (signal.aborted) {
          this.opts.log?.warn(`[HTTP ABORTED] ${method} ${url} after ${elapsed}ms: ${formatErrorValue(err)}`);
          throw abortReason(signal);
        }
        this.opts.log?.warn(`[HTTP ERROR] ${method} ${url} after ${elapsed}ms: ${formatErrorValue(err)}`);
        if (attempt >= policy.maxAttempts - 1) {
          throw new OmniRouteError(
            describeFetchError(err),
            undefined,
            false,
            "connect",
            url.replace(/^https?:\/\/[^/]+/, ""),
            elapsed
          );
        }
        const delay = retryDelayMs(undefined, attempt, policy);
        this.opts.log?.info(`[HTTP RETRY] Waiting ${delay}ms before attempt ${attempt + 2}...`);
        await sleep(delay, signal);
        continue;
      }
      if (res.ok || !isTransientHttpError(res.status) || attempt >= policy.maxAttempts - 1) {
        return res;
      }
      const delay = retryDelayMs(res, attempt, policy);
      this.opts.log?.warn(`[HTTP ${res.status}] Transient error from ${url}. Retrying in ${delay}ms...`);
      await sleep(delay, signal);
    }
  }

  async listModels(token?: { isCancellationRequested?: boolean; onCancellationRequested?: (listener: () => void) => { dispose(): void } }): Promise<OmniRouteModel[]> {
    const ctrl = new AbortController();
    // Large catalogs (3000+ models) or slow/remote servers (different IPs)
    // can take well over 8s to list models. Keep a generous HEADER budget so
    // model discovery doesn't abort mid-CONNECTION on real OmniRoute servers;
    // once headers arrive the server is proven alive, so the body read gets
    // its own fresh budget instead of being killed by the header timer.
    const headerTimeoutMs = 60_000;
    const bodyTimeoutMs = 30_000;
    let timer = setTimeout(
      () => ctrl.abort(new Error(`Timeout listing models after ${headerTimeoutMs}ms`)),
      headerTimeoutMs
    );
    let sub: { dispose(): void } | undefined;
    if (token?.onCancellationRequested) {
      if (token.isCancellationRequested) {
        clearTimeout(timer);
        return [];
      }
      sub = token.onCancellationRequested(() => ctrl.abort());
    }
    const t0 = Date.now();
    try {
      let res = await this.fetchWithRetry(`${this.baseUrl}/models?prefix=alias`, {
        method: "GET",
        headers: headers(this.opts.apiKey, false),
        signal: ctrl.signal,
      });
      // Some OpenAI-compatible servers expose /models off the root instead of
      // under /v1. Fall back so model discovery still succeeds there.
      if (!res.ok && (res.status === 404 || res.status === 405 || res.status === 501)) {
        res = await this.fetchWithRetry(`${serverRootUrl(this.baseUrl)}/models?prefix=alias`, {
          method: "GET",
          headers: headers(this.opts.apiKey, false),
          signal: ctrl.signal,
        });
      }
      if (!res.ok) {
        throw new OmniRouteError(
          `OmniRoute /models returned HTTP ${res.status}`,
          res.status,
          false,
          "headers",
          "/models"
        );
      }
      // Headers arrived: the server is alive. A slow body read must not be
      // aborted by the (possibly nearly-expired) header budget.
      clearTimeout(timer);
      timer = setTimeout(
        () => ctrl.abort(new Error(`Timeout reading models body after ${bodyTimeoutMs}ms`)),
        bodyTimeoutMs
      );
      if (token?.isCancellationRequested) return [];
      const body = (await res.json()) as ModelsResponse;
      const models = Array.isArray(body.data) ? body.data : [];
      this.opts.log?.info(`[MODELS] Listed ${models.length} model(s) from ${this.baseUrl} in ${Date.now() - t0}ms`);
      return models;
    } catch (err) {
      this.opts.log?.warn(`[MODELS ERROR] Failed listing models from ${this.baseUrl}: ${formatErrorValue(err)}`);
      throw err;
    } finally {
      clearTimeout(timer);
      sub?.dispose();
    }
  }

  /** POST /chat/completions with stream:true, yielding normalized events. */
  async *streamChat(request: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const firstByteMs = this.opts.streamFirstByteTimeoutMs ?? 120_000;
    const idleMs = this.opts.streamIdleTimeoutMs ?? 30_000;

    // Derived signal so a stall can abort this attempt without cancelling the
    // caller's own signal (which would kill the fallback chain).
    const session = new StreamSession(signal, firstByteMs, idleMs);
    try {
      const res = await this.fetchChatStream(request, session);
      if (!res.ok || !res.body) {
        throw await chatStreamError(res);
      }
      yield* this.consumeStream(res.body, session);
    } finally {
      session.dispose();
    }
  }

  /** POSTs the chat request under the session's signal; throws the upstream
   * error when the response is missing or not OK. */
  private async fetchChatStream(request: ChatRequest, session: StreamSession): Promise<Response> {
    try {
      return await this.fetchWithRetry(
        `${this.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: headers(this.opts.apiKey, true, true),
          body: JSON.stringify(request),
          signal: session.ctrl.signal,
          keepalive: true,
        },
        this.opts.chatMaxAttempts
      );
    } finally {
      session.clearFirstByteTimer();
    }
  }

  /** Reads the SSE body, feeding lines to {@link handleSseLine} and yielding
   * normalized events (with the encrypted-reasoning filter applied). */
  private async *consumeStream(
    stream: ReadableStream<Uint8Array>,
    session: StreamSession
  ): AsyncGenerator<StreamEvent> {
    const assembler = new ToolCallAssembler();
    const reasoningFilter = new EncryptedReasoningFilter();
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    session.setReader(reader);
    session.armWatchdog();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
          buffer = buffer.slice(newlineIdx + 1);
          yield* this.emitSseLine(line, assembler, reasoningFilter, session);
        }
      }
      session.throwIfAborted();
      yield* flushFilteredText(reasoningFilter);
      // Flush any tool calls still being assembled when the stream ends
      // without an explicit finish_reason line.
      yield* assembler.flush();
    } catch (err) {
      throw session.unwrapError(err);
    }
  }

  /** Handles one SSE line: normalizes events and keeps the stall watchdog
   * alive whenever the line carried real progress. */
  private async *emitSseLine(
    line: string,
    assembler: ToolCallAssembler,
    reasoningFilter: EncryptedReasoningFilter,
    session: StreamSession
  ): AsyncGenerator<StreamEvent> {
    const { events, alive } = this.handleSseLine(line, assembler);
    if (alive) session.poke();
    for (const event of events) {
      if (event.kind === "text") {
        yield* emitFilteredText(reasoningFilter, event.text);
      } else {
        yield* flushFilteredText(reasoningFilter);
        yield event;
      }
    }
  }

  /** Parses one SSE line. `events` carries the user-visible events (text,
   * flushed tool calls). `alive` is true whenever the line carried a valid
   * JSON chunk — proof the upstream is streaming, even if it yields nothing
   * yet (reasoning_content, partial tool_calls, usage-only). */
  private handleSseLine(line: string, assembler: ToolCallAssembler): { events: StreamEvent[]; alive: boolean } {
    if (!line.startsWith("data:")) return { events: [], alive: false };
    const payload = line.slice(5).trim();
    if (!payload) return { events: [], alive: false };
    if (payload === "[DONE]") return { events: [...assembler.flush()], alive: false };

    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(payload) as StreamChunk;
    } catch {
      return { events: [], alive: false }; // tolerate malformed keep-alive/comment payloads
    }

    if (chunk.error?.message) {
      throw sseError(chunk.error.message);
    }

    const choice = chunk.choices?.[0];
    if (!choice) return { events: [], alive: false };
    return this.processChoice(choice, assembler);
  }

  /** Normalizes one `choices[0]` delta into user-visible events. `alive` is
   * true on real progress (content/reasoning/tool deltas or finish_reason). */
  private processChoice(
    choice: NonNullable<StreamChunk["choices"]>[number],
    assembler: ToolCallAssembler
  ): { events: StreamEvent[]; alive: boolean } {
    const delta = choice.delta;
    const reasoning = extractReasoning(delta);
    // Only real progress keeps the idle watchdog alive. Empty-delta
    // keep-alives (e.g. OmniRoute's {delta:{}}) must NOT reset it, or a
    // model that stalls forever while the server keeps the stream open is
    // never killed → the chat hangs indefinitely.
    const progressed =
      delta?.content ?? reasoning ?? delta?.tool_calls ?? choice.finish_reason;
    const alive = progressed !== undefined && progressed !== null && progressed.length !== 0;

    const events: StreamEvent[] = [];
    // Filter out OmniRoute encrypted/private reasoning placeholder messages.
    if (reasoning && !isEncryptedReasoningNotice(reasoning)) {
      events.push({ kind: "text", text: reasoning });
    }
    if (delta?.content) {
      events.push({ kind: "text", text: delta.content });
    }
    if (delta?.tool_calls) {
      assembler.accept(delta.tool_calls);
    }
    if (choice.finish_reason) {
      events.push(...assembler.flush());
    }
    return { events, alive };
  }
}

/** Tracks one streaming attempt: a derived AbortController plus the
 * first-byte and idle watchdog timers. The derived signal lets a stall abort
 * this attempt without cancelling the caller's own signal (which would kill
 * the fallback chain). */
class StreamSession {
  readonly ctrl = new AbortController();
  private readonly relay: () => void;
  private firstByteTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  private hasRealEvent = false;

  constructor(
    private readonly signal: AbortSignal,
    private readonly firstByteMs: number,
    private readonly idleMs: number
  ) {
    this.relay = () => this.ctrl.abort(this.signal.reason);
    if (this.signal.aborted) {
      this.ctrl.abort(this.signal.reason);
    } else {
      this.signal.addEventListener("abort", this.relay, { once: true });
    }
    this.scheduleFirstByteTimer();
  }

  private scheduleFirstByteTimer(): void {
    this.clearFirstByteTimer();
    this.firstByteTimer = setTimeout(() => {
      this.ctrl.abort(
        new OmniRouteError(
          `OmniRoute did not start responding within ${this.firstByteMs / 1000}s`,
          408,
          true,
          "connect",
          "/chat/completions"
        )
      );
    }, this.firstByteMs);
  }

  clearFirstByteTimer(): void {
    if (this.firstByteTimer) {
      clearTimeout(this.firstByteTimer);
      this.firstByteTimer = undefined;
    }
  }

  /** Real progress (a valid SSE line) — notify the idle watchdog. */
  poke(): void {
    this.hasRealEvent = true;
    this.resetWatchdog();
  }

  /** Arm the idle watchdog once reading begins (headers already received, so
   * the pre-first-event window starts counting from here, not from connect). */
  armWatchdog(): void {
    this.resetWatchdog();
  }

  /** Abort the body reader when the session is cancelled, so the underlying
   * socket is released promptly. Listens on the derived controller — a stall
   * abort must cancel our own read, not the caller's signal. */
  setReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    const cancel = () => {
      try {
        void reader.cancel(this.ctrl.signal.reason);
      } catch {
        // reader.cancel after abort — safe to ignore
      }
    };
    if (this.ctrl.signal.aborted) {
      cancel();
    } else {
      this.ctrl.signal.addEventListener("abort", cancel, { once: true });
    }
  }

  throwIfAborted(): void {
    if (this.ctrl.signal.aborted) {
      const reason = this.ctrl.signal.reason;
      if (reason instanceof OmniRouteError) throw reason;
      throw new OmniRouteError(formatErrorValue(reason), undefined, true, "stream", "/chat/completions");
    }
  }

  /** Errors raised while consuming may be the abort we triggered ourselves;
   * normalize them so callers see a consistent stall error. */
  unwrapError(err: unknown): unknown {
    if (this.ctrl.signal.aborted) {
      const reason = this.ctrl.signal.reason;
      if (reason instanceof OmniRouteError) return reason;
      return new OmniRouteError(formatErrorValue(reason), undefined, true, "stream", "/chat/completions");
    }
    return err;
  }

  dispose(): void {
    this.clearFirstByteTimer();
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
    if (!this.signal.aborted) {
      this.signal.removeEventListener("abort", this.relay);
    }
  }

  /** Idle watchdog: abort once no real progress arrives within the window.
   * Before the first byte the cap is firstByteMs; afterwards idleMs. */
  private resetWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
    const ms = !this.hasRealEvent ? this.firstByteMs : this.idleMs;
    this.watchdogTimer = setTimeout(() => {
      this.ctrl.abort(this.timeoutError(ms));
    }, ms);
  }

  private timeoutError(ms: number): OmniRouteError {
    const message = !this.hasRealEvent
      ? `OmniRoute did not start responding within ${ms / 1000}s`
      : `OmniRoute went silent for ${ms / 1000}s`;
    return new OmniRouteError(message, 408, true, "stream", "/chat/completions");
  }
}

/** Reassembles incremental tool_calls deltas (indexed fragments) into
 * complete calls, emitted once their JSON arguments are whole. */
class ToolCallAssembler {
  private readonly pending = new Map<number, { id: string; name: string; args: string }>();

  accept(deltas: StreamToolCallDelta[]): void {
    for (const d of deltas) {
      const slot = this.pending.get(d.index) ?? { id: "", name: "", args: "" };
      if (d.id) slot.id = d.id;
      if (d.function?.name) slot.name += d.function.name;
      if (d.function?.arguments) slot.args += d.function.arguments;
      this.pending.set(d.index, slot);
    }
  }

  *flush(): Generator<StreamEvent> {
    for (const [, call] of [...this.pending.entries()].sort(([a], [b]) => a - b)) {
      if (!call.id || !call.name) continue;
      yield { kind: "toolCall", id: call.id, name: call.name, args: call.args || "{}" };
    }
    this.pending.clear();
  }
}

/** Filters out OmniRoute encrypted/private reasoning notice messages,
 * even when streamed across multiple incremental SSE text chunks. */
export class EncryptedReasoningFilter {
  private buffer = "";

  private static readonly KNOWN_PATTERNS = [
    "codex is reasoning, but upstream responses api exposed this reasoning block only as encrypted private reasoning. omniroute cannot recover plaintext.",
    "upstream responses api exposed this reasoning block only as encrypted private reasoning",
    "encrypted private reasoning. omniroute cannot recover plaintext",
    "omniroute cannot recover plaintext",
    "encrypted private reasoning",
  ];

  public push(chunk: string): string[] {
    if (!chunk) return [];
    this.buffer += chunk;
    const normalized = this.buffer.trim().toLowerCase().replace(/\s+/g, " ");

    for (const pattern of EncryptedReasoningFilter.KNOWN_PATTERNS) {
      if (normalized.includes(pattern)) {
        this.buffer = "";
        return [];
      }
    }

    const isNoticePrefix = EncryptedReasoningFilter.KNOWN_PATTERNS.some((pattern) =>
      pattern.startsWith(normalized) || normalized.startsWith(pattern.slice(0, Math.min(pattern.length, normalized.length)))
    );

    if (isNoticePrefix && this.buffer.length < 250) {
      return [];
    }

    const out = this.buffer;
    this.buffer = "";
    return [out];
  }

  public flush(): string[] {
    if (!this.buffer) return [];
    const normalized = this.buffer.trim().toLowerCase().replace(/\s+/g, " ");
    for (const pattern of EncryptedReasoningFilter.KNOWN_PATTERNS) {
      if (normalized.includes(pattern) || pattern.startsWith(normalized)) {
        this.buffer = "";
        return [];
      }
    }
    const out = this.buffer;
    this.buffer = "";
    return [out];
  }
}

/** Extracts reasoning text from a streaming delta, across the shapes
 * different providers expose (reasoning_content, reasoning, thinking,
 * thought, reasoning_text, reasoning_delta, thoughts). */
function extractReasoning(delta: StreamDelta | undefined): string | undefined {
  const dAny = delta as Record<string, unknown> | undefined;
  return (
    delta?.reasoning_content ??
    delta?.reasoning ??
    delta?.thinking ??
    (typeof dAny?.thought === "string" ? dAny.thought : undefined) ??
    (typeof dAny?.reasoning_text === "string" ? dAny.reasoning_text : undefined) ??
    (typeof dAny?.reasoning_delta === "string" ? dAny.reasoning_delta : undefined) ??
    (typeof dAny?.thoughts === "string" ? dAny.thoughts : undefined)
  );
}

/** True when the text is OmniRoute's encrypted/private reasoning notice,
 * which must be filtered out rather than shown to the user. */
function isEncryptedReasoningNotice(reasoning: string): boolean {
  return (
    reasoning.includes("encrypted private reasoning") &&
    reasoning.includes("OmniRoute cannot recover plaintext")
  );
}

async function safeErrorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    return parsed.error?.message ?? text.slice(0, 200);
  } catch {
    return "";
  }
}

/** Error from a streamed SSE `error` payload. The upstream message usually
 *  carries a `[status]: detail` prefix — extract it so the provider can tell
 *  transient (retry/fallback) failures from permanent ones. */
function sseError(message: string): OmniRouteError {
  const m = /^\[(\d{3})\]:\s*/.exec(message);
  if (m) return new OmniRouteError(message, Number(m[1]), false, "stream", "/chat/completions");
  const lower = message.toLowerCase();
  let status: number | undefined = undefined;
  if (
    lower.includes("rate limit") ||
    lower.includes("ratelimit") ||
    lower.includes("too many requests") ||
    lower.includes("quota") ||
    lower.includes("concurrency") ||
    lower.includes("resource_exhausted")
  ) {
    status = 429;
  } else if (
    lower.includes("overloaded") ||
    lower.includes("busy") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("capacity") ||
    lower.includes("service unavailable")
  ) {
    status = 503;
  }
  return new OmniRouteError(message, status, false, "stream", "/chat/completions");
}

/** Non-OK / bodyless chat response: surface the upstream detail plus any
 * Retry-After hint so the caller's backoff can honor it instead of guessing. */
async function chatStreamError(res: Response): Promise<OmniRouteError> {
  const detail = await safeErrorDetail(res);
  const retryAfter = res.headers.get("retry-after");
  const retryAfterMs =
    retryAfter !== null && Number(retryAfter) > 0 ? Number(retryAfter) * 1000 : undefined;
  const detailSuffix = detail ? `: ${detail}` : "";
  return new OmniRouteError(
    `OmniRoute request failed (HTTP ${res.status})${detailSuffix}`,
    res.status,
    false,
    "headers",
    "/chat/completions",
    undefined,
    retryAfterMs
  );
}

/** Yields any text the reasoning filter lets through, as TextStreamEvents. */
async function* emitFilteredText(
  filter: EncryptedReasoningFilter,
  text: string
): AsyncGenerator<StreamEvent> {
  for (const piece of filter.push(text)) {
    yield { kind: "text", text: piece };
  }
}

/** Yields whatever the reasoning filter still holds at end-of-stream. */
async function* flushFilteredText(filter: EncryptedReasoningFilter): AsyncGenerator<StreamEvent> {
  for (const piece of filter.flush()) {
    yield { kind: "text", text: piece };
  }
}
