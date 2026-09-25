import { rpc as endpoint } from "./config";

type Body<T> = { result?: T; error?: { message?: string } };

export async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await endpoint.fetch(endpoint.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = (await response.json()) as Body<T>;
  if (body.error) throw new Error(`${method}: ${body.error.message ?? "RPC error"}`);
  return body.result as T;
}

export async function latestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: bigint }> {
  const r = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [
    { commitment: "confirmed" },
  ]);
  return { blockhash: r.value.blockhash, lastValidBlockHeight: BigInt(r.value.lastValidBlockHeight) };
}

/** Whether an account exists yet, at confirmed commitment. */
export async function accountExists(address: string): Promise<boolean> {
  const r = await rpc<{ value: unknown | null }>("getAccountInfo", [
    address,
    { encoding: "base64", commitment: "confirmed" },
  ]);
  return r.value !== null;
}

/** Poll until `address` exists or `timeoutMs` passes. */
export async function waitForAccount(address: string, timeoutMs = 60_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await accountExists(address).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}
