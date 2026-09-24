/**
 * Issuing with storage and a signer attached: the order of the durable writes
 * is the whole of this file.
 *
 *   prepare → save → sign → complete → save → hand over
 *
 * The voucher is returned only after the second save. So a voucher a merchant
 * has seen is always recorded as outstanding, and a pending one was never seen
 * by anyone. That is what makes {@link resume} safe: it re-signs a message
 * nobody holds.
 */
import {
  complete,
  DEFAULT_ISSUE_POLICY,
  pendingMessage,
  prepare,
  type IssuePolicy,
  type IssueRequest,
  type IssuerState,
} from "./issuer.ts";

export interface IssuerStore {
  load(): Promise<IssuerState | null>;
  /** Must be durable when it resolves. */
  save(state: IssuerState): Promise<void>;
}

/** StrongBox, via `@nelo/attest`'s `sign`: raw 64-byte r‖s, low-S. */
export type Sign = (message: Uint8Array) => Promise<Uint8Array>;

export type Issued = { ok: true; packet: Uint8Array } | { ok: false; reason: string; unfinished?: boolean };

export async function pay(
  store: IssuerStore,
  sign: Sign,
  request: IssueRequest,
  randomBytes: (n: number) => Uint8Array,
  policy: IssuePolicy = DEFAULT_ISSUE_POLICY,
): Promise<Issued> {
  const state = await store.load();
  if (!state) return { ok: false, reason: "This phone is not enrolled to a vault." };
  if (state.pending) {
    return { ok: false, unfinished: true, reason: "A payment was interrupted. Finish it before starting another." };
  }

  const prepared = prepare(state, request, randomBytes(8), policy);
  if (!prepared.ok) return prepared;
  // Durable before anything is signed. From here on this sequence belongs to
  // exactly these bytes.
  await store.save(prepared.state);
  return finish(store, sign, prepared.state);
}

/**
 * Sign the interrupted voucher — the same bytes it was fixed with, never new
 * ones — and hand it over.
 */
export async function resume(store: IssuerStore, sign: Sign): Promise<Issued> {
  const state = await store.load();
  if (!state?.pending) return { ok: false, reason: "Nothing was interrupted." };
  return finish(store, sign, state);
}

async function finish(store: IssuerStore, sign: Sign, state: IssuerState): Promise<Issued> {
  const message = pendingMessage(state)!;
  let signature: Uint8Array;
  try {
    signature = await sign(message);
  } catch (e) {
    // Cancelled at the biometric prompt, or the keystore failed. The pending
    // voucher stays exactly as it is, and `resume` picks it up.
    return { ok: false, unfinished: true, reason: e instanceof Error ? e.message : "Signing failed." };
  }
  const completed = complete(state, signature);
  if (!completed.ok) return { ...completed, unfinished: true };
  await store.save(completed.state);
  return { ok: true, packet: completed.packet };
}
