import type {
  ChatRequest,
  ModelsResponse,
  OmniRouteModel,
  StreamChunk,
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

/** Normalize a user-supplied base URL: trim, drop trailing slashes, ensure /v1. */
export function normalizeBaseUrl(raw: string): string {
  let url = (raw || "").trim().replace(/\/+$/, "");
  if (!url) return "http://127.0.0.1:20128/v1";
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
    public readonly latencyMs?: number
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
  if (!(error instanceof Error)) return String(error);
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

/** Statuses worth retrying: request timeout, rate limit, and 5xx range. */
export function isTransientHttpError(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 504);
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
  return Math.min(policy.maxMs, base + Math.random() * Math.min(base, 200));
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
      this.opts.log?.warn(`[PING FAILED] ${this.baseUrl} -> OFFLINE (${elapsed}ms): ${String(err)}`);
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
          this.opts.log?.warn(`[HTTP ABORTED] ${method} ${url} after ${elapsed}ms: ${String(err)}`);
          throw abortReason(signal);
        }
        this.opts.log?.warn(`[HTTP ERROR] ${method} ${url} after ${elapsed}ms: ${String(err)}`);
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
    // can take well over 8s to list models. Keep this generous so model
    // discovery doesn't abort mid-CONNECTION on real OmniRoute servers.
    const timeoutMs = 30_000;
    const timer = setTimeout(() => ctrl.abort(new Error(`Timeout listing models after ${timeoutMs}ms`)), timeoutMs);
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
      let res = await this.fetchWithRetry(`${this.baseUrl}/models`, {
        method: "GET",
        headers: headers(this.opts.apiKey, false),
        signal: ctrl.signal,
      });
      // Some OpenAI-compatible servers expose /models off the root instead of
      // under /v1. Fall back so model discovery still succeeds there.
      if (!res.ok && (res.status === 404 || res.status === 405 || res.status === 501)) {
        res = await this.fetchWithRetry(`${serverRootUrl(this.baseUrl)}/models`, {
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
      if (token?.isCancellationRequested) return [];
      const body = (await res.json()) as ModelsResponse;
      const models = Array.isArray(body.data) ? body.data : [];
      this.opts.log?.info(`[MODELS] Listed ${models.length} model(s) from ${this.baseUrl} in ${Date.now() - t0}ms`);
      return models;
    } catch (err) {
      this.opts.log?.warn(`[MODELS ERROR] Failed listing models from ${this.baseUrl}: ${String(err)}`);
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
    const ctrl = new AbortController();
    const relay = () => ctrl.abort(signal.reason);
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener("abort", relay, { once: true });

    // The first-byte cap must also bound the connect/headers phase: an
    // upstream (proxy/OmniRoute) that accepts the connection and then hangs
    // would otherwise block the whole request for as long as fetch allows.
    const firstByteTimer = setTimeout(
      () =>
        ctrl.abort(
          new OmniRouteError(
            `OmniRoute did not start responding within ${firstByteMs / 1000}s`,
            408,
            true,
            "connect",
            "/chat/completions"
          )
        ),
      firstByteMs
    );

    let res: Response;
    try {
      res = await this.fetchWithRetry(
        `${this.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: headers(this.opts.apiKey, true, true),
          body: JSON.stringify(request),
          signal: ctrl.signal,
          keepalive: true,
        },
        this.opts.chatMaxAttempts
      );
    } finally {
      clearTimeout(firstByteTimer);
    }

    if (!res.ok || !res.body) {
      const detail = await safeErrorDetail(res);
      throw new OmniRouteError(
        `OmniRoute request failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
        res.status,
        false,
        "headers",
        "/chat/completions"
      );
    }

    const assembler = new ToolCallAssembler();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const timeoutErr = (ms: number) =>
      new OmniRouteError(
        !hasRealEvent
          ? `OmniRoute did not start responding within ${ms / 1000}s`
          : `OmniRoute went silent for ${ms / 1000}s`,
        408,
        true,
        "stream",
        "/chat/completions"
      );

    let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
    let hasRealEvent = false;

    const resetWatchdog = () => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      const ms = !hasRealEvent ? firstByteMs : idleMs;
      watchdogTimer = setTimeout(() => {
        ctrl.abort(timeoutErr(ms));
      }, ms);
    };

    resetWatchdog();

    try {
      ctrl.signal.addEventListener(
        "abort",
        () => {
          try {
            void reader.cancel(ctrl.signal.reason);
          } catch {
            // reader.cancel after abort — safe to ignore
          }
        },
        { once: true }
      );

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
          buffer = buffer.slice(newlineIdx + 1);
          const { events, alive } = this.handleSseLine(line, assembler);
          if (alive) {
            if (!hasRealEvent) hasRealEvent = true;
            resetWatchdog();
          }
          yield* events;
        }
      }
      if (ctrl.signal.aborted) {
        if (ctrl.signal.reason instanceof OmniRouteError) throw ctrl.signal.reason;
        throw abortReason(ctrl.signal);
      }
      // Flush any tool calls still being assembled when the stream ends
      // without an explicit finish_reason line.
      yield* assembler.flush();
    } catch (err) {
      if (ctrl.signal.aborted && ctrl.signal.reason instanceof OmniRouteError) {
        throw ctrl.signal.reason;
      }
      throw err;
    } finally {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      signal.removeEventListener("abort", relay);
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

    const events: StreamEvent[] = [];
    let alive = false;
    const choice = chunk.choices?.[0];
    if (choice) {
      const delta = choice.delta;
      // Only real progress keeps the idle watchdog alive. Empty-delta
      // keep-alives (e.g. OmniRoute's {delta:{}}) must NOT reset it, or a
      // model that stalls forever while the server keeps the stream open is
      // never killed → the chat hangs indefinitely.
      const progressed =
        delta?.content ?? delta?.reasoning_content ?? delta?.tool_calls ?? choice.finish_reason;
      alive = progressed !== undefined && progressed !== null && progressed.length !== 0;
      if (delta?.content) {
        events.push({ kind: "text", text: delta.content });
      }
      if (delta?.tool_calls) {
        assembler.accept(delta.tool_calls);
      }
      if (choice.finish_reason) {
        events.push(...assembler.flush());
      }
    }
    return { events, alive };
  }
}

/** Reassembles incremental tool_calls deltas (indexed fragments) into
 * complete calls, emitted once their JSON arguments are whole. */
class ToolCallAssembler {
  private pending = new Map<number, { id: string; name: string; args: string }>();

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
  return new OmniRouteError(message, undefined, false, "stream", "/chat/completions");
}
