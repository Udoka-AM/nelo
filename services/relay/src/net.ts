/**
 * Outbound requests that survive a flaky DNS or connection.
 *
 * Node reports any network failure as a bare "fetch failed", with the reason
 * on `cause`. A failure to look up the host or open the connection means the
 * request never left this machine, so it is safe to try again, even a POST
 * that opens a payout. Anything after the connection opened is not retried.
 */
const BEFORE_SENDING = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

/** The network code behind a fetch failure, if there is one. */
export function networkCode(e: unknown): string | null {
  const cause = (e as { cause?: { code?: unknown; cause?: { code?: unknown } } } | null)?.cause;
  const code = cause?.code ?? cause?.cause?.code;
  return typeof code === "string" ? code : null;
}

export async function reach<T>(url: string, attempt: () => Promise<T>, delaysMs: number[] = [500, 1_500, 3_000]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (e) {
      const code = networkCode(e);
      if (code && BEFORE_SENDING.has(code) && i < delaysMs.length) {
        await new Promise((r) => setTimeout(r, delaysMs[i]));
        continue;
      }
      if (code) {
        const host = new URL(url).host;
        const hint = code === "ENOTFOUND" || code === "EAI_AGAIN" ? "this computer could not look up its address (DNS)" : "the connection failed";
        throw new Error(`cannot reach ${host}: ${hint} [${code}]`, { cause: e });
      }
      throw e;
    }
  }
}
