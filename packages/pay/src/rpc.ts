/**
 * Minimal JSON-RPC over fetch.
 *
 * No SDK. This is a handful of methods, and `fetch` works identically in Node
 * and Hermes, so nothing here needs a polyfill or a bundler exception — which
 * matters on a React Native app where every dependency is a bundle-size and a
 * compatibility decision.
 */
export async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) {
    throw new Error(`RPC ${method} failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`RPC ${method} failed: ${body.error.message}`);
  return body.result as T;
}
