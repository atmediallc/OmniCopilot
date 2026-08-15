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

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
  retry?: RetryPolicy;
  /** Abort a streaming response if no byte arrives within this long (ms).
   * Guards against dead proxies that accept the connection and never send
   * headers/body. Default 15000. */
  streamFirstByteTimeoutMs?: number;
  /** Abort a streaming response that sends no further data for this long (ms)
   * once streaming has started. Default 30000. */
  streamIdleTimeoutMs?: number;
}

const USER_AGENT = "OmniCopilot-VSCode";

function headers(apiKey: string | undefined, json: boolean): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": USER_AGENT };
  if (json) h["Content-Type"] = "application/json";
  if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
  return h;
}

/** Normalize a user-supplied base URL: trim, drop trailing slashes, ensure /v1. */
export function normalizeBaseUrl(raw: string): string {
  let url = (raw || "").trim().replace(/\/+$/, "");
  if (!url) return "http://localhost:20128/v1";
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  if (!/\/v1$/i.test(url)) url = `${url}/v1`;
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
    public readonly status?: number
  ) {
    super(message);
    this.name = "OmniRouteError";
  }
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
    if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1000;
  }
  const base = Math.min(policy.maxMs, policy.baseMs * 2 ** attempt);
  return Math.min(policy.maxMs, base + Math.random() * Math.min(base, 200));
}

/** Ordered fallback candidates for a chat request that keeps failing with
 * transient server errors: same provider family first, then any compatible
 * model. The primary id is always excluded. */
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
  async ping(timeoutMs = 4000): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        method: "HEAD",
        headers: headers(this.opts.apiKey, false),
        signal: ctrl.signal,
      });
      return res.ok || res.status === 401 || res.status === 403;
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
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    const signal = init.signal ?? new AbortController().signal;
    const maxAttempts = Math.max(1, this.opts.retry?.maxAttempts ?? RETRY_DEFAULTS.maxAttempts);
    const policy: Required<RetryPolicy> = {
      maxAttempts,
      baseMs: this.opts.retry?.baseMs ?? RETRY_DEFAULTS.baseMs,
      maxMs: this.opts.retry?.maxMs ?? RETRY_DEFAULTS.maxMs,
    };
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw abortReason(signal);
      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (err) {
        // Network-level failure (DNS, refused, reset, TLS…): transient unless
        // this was the final attempt. Keeps flaky servers from killing a
        // request outright and lets the caller's fallback chain take over.
        if (attempt >= policy.maxAttempts - 1) throw err;
        await sleep(retryDelayMs(undefined, attempt, policy), signal);
        continue;
      }
      if (res.ok || !isTransientHttpError(res.status) || attempt >= policy.maxAttempts - 1) {
        return res;
      }
      await sleep(retryDelayMs(res, attempt, policy), signal);
    }
  }

  async listModels(token?: { isCancellationRequested?: boolean }): Promise<OmniRouteModel[]> {
    const res = await this.fetchWithRetry(`${this.baseUrl}/models`, {
      method: "GET",
      headers: headers(this.opts.apiKey, false),
    });
    if (!res.ok) {
      throw new OmniRouteError(`OmniRoute /models returned HTTP ${res.status}`, res.status);
    }
    if (token?.isCancellationRequested) return [];
    const body = (await res.json()) as ModelsResponse;
    return Array.isArray(body.data) ? body.data : [];
  }

  /** POST /chat/completions with stream:true, yielding normalized events. */
  async *streamChat(request: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const firstByteMs = this.opts.streamFirstByteTimeoutMs ?? 15_000;
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
            408
          )
        ),
      firstByteMs
    );

    let res: Response;
    try {
      res = await this.fetchWithRetry(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: headers(this.opts.apiKey, true),
        body: JSON.stringify(request),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(firstByteTimer);
    }

    if (!res.ok || !res.body) {
      const detail = await safeErrorDetail(res);
      throw new OmniRouteError(
        `OmniRoute request failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
        res.status
      );
    }

    const assembler = new ToolCallAssembler();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const timeoutErr = (ms: number) =>
      new OmniRouteError(
        ms === firstByteMs
          ? `OmniRoute did not start responding within ${firstByteMs / 1000}s`
          : `OmniRoute went silent for ${idleMs / 1000}s`,
        408
      );

    // Watchdog: the stream is bounded by the first-byte cap until the first
    // live SSE chunk arrives, then by the idle cap since the last live chunk.
    // A chunk counts as live even when it yields no visible text yet
    // (reasoning_content, tool-call deltas) — a server streaming those IS
    // responding. Keep-alive/comment lines (`: …`) and empty `data:` payloads
    // do NOT extend the deadline — an upstream that streams keep-alives while
    // stuck (e.g. a rate-limited proxy that eventually emits
    // `data: {"error": …}`) must fail fast instead of leaving the chat
    // hanging for minutes.
    const firstByteDeadline = Date.now() + firstByteMs;
    let idleDeadline = 0;
    let stalled = false;
    let hasRealEvent = false;

    const stall = () => {
      stalled = true;
      const ms = !hasRealEvent ? firstByteMs : idleMs;
      const err = timeoutErr(ms);
      ctrl.abort(err);
      return err;
    };

    const waitMs = (ms: number) =>
      new Promise<{ timeout: true }>((resolve) => {
        setTimeout(() => resolve({ timeout: true }), ms);
      });

    try {
      for (;;) {
        const now = Date.now();
        const deadline = !hasRealEvent ? firstByteDeadline : idleDeadline;
        const timeoutP = waitMs(Math.max(deadline - now, 0));
        const readP = reader.read().then(
          (v) => ({ ok: true as const, v }),
          (e) => ({ ok: false as const, e })
        );
        const result = await Promise.race([readP, timeoutP]);

        if ("timeout" in result) {
          stalled = true;
          throw stall();
        }
        if (!result.ok) throw result.e;
        const { done, value } = result.v;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
          buffer = buffer.slice(newlineIdx + 1);
          const { events, alive } = this.handleSseLine(line, assembler);
          if (alive) {
            if (!hasRealEvent) hasRealEvent = true;
            idleDeadline = Date.now() + idleMs;
          }
          yield* events;
        }
      }
      // Flush any tool calls still being assembled when the stream ends
      // without an explicit finish_reason line.
      yield* assembler.flush();
    } catch (err) {
      if (stalled) throw stall();
      throw err;
    } finally {
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
    const choice = chunk.choices?.[0];
    if (choice) {
      const delta = choice.delta;
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
    return { events, alive: true };
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
  if (m) return new OmniRouteError(message, Number(m[1]));
  return new OmniRouteError(message, undefined);
}
