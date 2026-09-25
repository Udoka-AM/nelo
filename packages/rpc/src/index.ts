/**
 * RPC failover.
 *
 * One RPC endpoint is one point of failure for every till, every payer and
 * the relayer. A free-tier key runs out of quota at the worst moment, and a
 * rate limit looks, from a till, exactly like a customer who has not paid.
 *
 * `failover(urls)` returns an endpoint whose `fetch` is a drop-in for the
 * `fetch` every JSON-RPC call here already makes. Each request goes to the
 * first endpoint not resting, and moves to the next only when the one it
 * asked did not answer:
 *
 * - the request failed or timed out,
 * - HTTP 429 or any 5xx,
 * - a JSON-RPC error that says the node, not the request, is the problem
 *   (`-32005`, node behind; or a rate-limit message).
 *
 * Anything else is an answer, and is returned as it is: an invalid-params
 * error, a simulation failure, a 4xx. Asking a second node the same wrong
 * question gets the same answer and hides the bug.
 *
 * ## Why resending is safe
 *
 * A request that timed out may still have arrived. For reads that costs
 * nothing. For `sendTransaction` the retry carries the same signed bytes, so
 * it is the same transaction with the same signature, and the chain runs it
 * at most once. Nothing here builds or signs anything.
 *
 * An endpoint that failed rests for `restMs`, so a node that is down is not
 * asked first on every request. If every endpoint is resting, all are tried
 * anyway, soonest back first: a request is never refused without trying.
 */

type FetchInit = {
  method?: string;
  headers?: Record<string, string> | HeadersInit;
  body?: string | null | BodyInit;
  signal?: AbortSignal | null;
};
type FetchLike = (input: string, init?: FetchInit) => Promise<Response>;

export interface Endpoint {
  /** The preferred endpoint, for display and for code that wants a URL. */
  url: string;
  /** Every endpoint, in order of preference. */
  urls: readonly string[];
  /** Drop-in for `fetch` against the RPC. The URL passed in is ignored. */
  fetch: typeof fetch;
}

export interface FailoverOptions {
  /** Per attempt. Default 8 s: long enough for a slow send, short enough for a till. */
  timeoutMs?: number;
  /** How long an endpoint that failed is asked last. Default 30 s. */
  restMs?: number;
  now?: () => number;
  fetch?: FetchLike;
  /** Told each time a request moves on from an endpoint. */
  onFailover?: (url: string, reason: string) => void;
}

/** JSON-RPC errors that are about the node, not the request. */
const NODE_UNHEALTHY = new Set([-32005]);
const RATE_LIMITED = /rate.?limit|too many requests/i;

type Attempt = { ok: true; response: Response } | { ok: false; reason: string };

export function failover(urls: readonly string[], options: FailoverOptions = {}): Endpoint {
  const list = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
  if (list.length === 0) throw new Error("failover needs at least one RPC URL");
  const timeoutMs = options.timeoutMs ?? 8_000;
  const restMs = options.restMs ?? 30_000;
  const now = options.now ?? Date.now;
  const base: FetchLike = options.fetch ?? ((input, init) => fetch(input, init as RequestInit));
  const restingUntil = new Map<string, number>();

  async function attempt(url: string, init: FetchInit): Promise<Attempt> {
    const controller = new AbortController();
    const outer = init.signal;
    const onAbort = () => controller.abort();
    outer?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await base(url, { ...init, signal: controller.signal });
      if (response.status === 429 || response.status >= 500) return { ok: false, reason: `HTTP ${response.status}` };
      const text = await response.text();
      if (response.ok) {
        const error = errorOf(text);
        if (error && (NODE_UNHEALTHY.has(error.code) || RATE_LIMITED.test(error.message))) {
          return { ok: false, reason: `RPC ${error.code}: ${error.message}` };
        }
      }
      // Rebuilt, because the body has been read; callers read it again.
      return {
        ok: true,
        response: new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers }),
      };
    } catch (e) {
      if (outer?.aborted) throw e;
      return { ok: false, reason: controller.signal.aborted ? `timed out after ${timeoutMs} ms` : String(e) };
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
  }

  const rpcFetch: FetchLike = async (_input, init = {}) => {
    const t = now();
    const awake = list.filter((u) => (restingUntil.get(u) ?? 0) <= t);
    const resting = list
      .filter((u) => (restingUntil.get(u) ?? 0) > t)
      .sort((a, b) => restingUntil.get(a)! - restingUntil.get(b)!);
    const reasons: string[] = [];
    for (const url of [...awake, ...resting]) {
      const r = await attempt(url, init);
      if (r.ok) {
        restingUntil.delete(url);
        return r.response;
      }
      restingUntil.set(url, now() + restMs);
      options.onFailover?.(url, r.reason);
      reasons.push(`${hostOf(url)}: ${r.reason}`);
    }
    throw new Error(`every RPC endpoint failed (${reasons.join("; ")})`);
  };

  return { url: list[0]!, urls: list, fetch: rpcFetch as unknown as typeof fetch };
}

/**
 * The endpoints to use, from configuration: the preferred one, then a
 * comma-separated list of fallbacks, then any last resort, without repeats.
 */
export function endpointsFrom(primary: string | undefined, fallbacks: string | undefined, lastResort?: string): string[] {
  const all = [primary ?? "", ...(fallbacks ?? "").split(","), lastResort ?? ""].map((u) => u.trim()).filter(Boolean);
  return [...new Set(all)];
}

function errorOf(text: string): { code: number; message: string } | null {
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    const e = body?.error;
    if (!e || typeof e !== "object") return null;
    return { code: typeof e.code === "number" ? e.code : 0, message: typeof e.message === "string" ? e.message : "" };
  } catch {
    return null;
  }
}

/** Never log an API key: the host is enough to say which endpoint failed. */
function hostOf(url: string): string {
  const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(url);
  return m ? m[1]! : "rpc";
}
