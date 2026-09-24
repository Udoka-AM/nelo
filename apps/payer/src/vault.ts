/**
 * The payer's vault: open it, fund it, and keep the phone's view of it fresh.
 *
 * Opening does three things in an order that matters:
 *
 *   1. make the payment key in the secure element,
 *   2. open the vault on chain with that key enrolled, and a first deposit,
 *   3. save the issuer state that will number every voucher from now on.
 *
 * If it stops between 1 and 2, the key is simply made again. Nothing on chain
 * knows it yet. If it stops between 2 and 3, the vault exists and the phone
 * holds its key, and the next open finishes step 3 from the chain. What cannot
 * be recovered is losing this phone's key after step 2. The program has no way
 * to enrol a new key on an existing vault, so that payer needs a new wallet.
 * The screen says so plainly.
 */
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import { sha256 } from "@noble/hashes/sha2";
import * as attest from "@nelo/attest";
import { applySnapshot, emptyCache, fetchSome, jsonRpc, lookup } from "@nelo/enrol";
import { applyChain, chainViewOf, initialState, type IssuerState } from "@nelo/issue";
import {
  buildTransaction,
  depositInstruction,
  initializeVaultInstruction,
  TOKEN_PROGRAM_ID,
  vaultAddress,
} from "@nelo/redeem";
import { decodeBase64 } from "@nelo/voucher";
import { FLOOR_LIMIT, KEY_ALIAS, rpcUrl, USDC_DEVNET } from "./config";
import { accountExists, latestBlockhash, waitForAccount } from "./rpc";
import { issuerStore } from "./storage";
import { signAndSend } from "./wallet";

const PROFILE_KEY = "nelo.payer.profile";

export interface Profile {
  owner: string;
  vault: string;
  /** Hex, SEC1 compressed. Kept so step 3 can be finished after a crash. */
  devicePubkey: string;
  strongBoxBacked: boolean;
}

export async function loadProfile(): Promise<Profile | null> {
  const raw = await SecureStore.getItemAsync(PROFILE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Profile;
  } catch {
    return null;
  }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(i * 2, i * 2 + 2), 16));

/** The vault account and the risk config, as the issuer sees them. */
async function readChain(vault: string) {
  const now = Math.floor(Date.now() / 1000);
  const { snapshot } = await fetchSome(jsonRpc(rpcUrl), [vault], { now, mint: USDC_DEVNET });
  const cache = applySnapshot(emptyCache(), snapshot);
  const found = lookup(cache, vault);
  if (!found.found) {
    throw new Error(found.missing === "risk" ? "The platform's risk settings are not on chain yet." : "Your vault was not found on chain.");
  }
  const account = snapshot.vaults.find((v) => v.address === vault)!.account;
  return { account, view: chainViewOf(vault, account, found.risk, now) };
}

export type Enrolled = { ok: true; state: IssuerState; profile: Profile } | { ok: false; reason: string };

export async function enrol(owner: string, firstDeposit: bigint): Promise<Enrolled> {
  if (!attest.isAvailable()) return { ok: false, reason: "This build has no secure-element module. Use a development build." };
  const vault = vaultAddress(owner);

  const existing = await loadProfile();
  if (existing && existing.owner === owner && (await accountExists(vault))) {
    // Step 2 happened; finish step 3 from the chain.
    return finish(existing);
  }
  if (await accountExists(vault)) {
    return {
      ok: false,
      reason:
        "This wallet already has a vault, enrolled to a key this phone does not hold. Nelo cannot move a vault to a new phone yet; use a different wallet.",
    };
  }

  // Step 1. Nothing on chain knows any key yet, so a leftover one is replaced.
  if (attest.hasKey(KEY_ALIAS)) await attest.deleteKey(KEY_ALIAS);
  const key = await attest.generateAttestedKey(KEY_ALIAS, Crypto.getRandomBytes(32));
  const chain = key.certChain.map((c) => decodeBase64(c));
  const attestationId = sha256(chain.reduce((all, c) => {
    const out = new Uint8Array(all.length + c.length);
    out.set(all);
    out.set(c, all.length);
    return out;
  }, new Uint8Array()));

  const profile: Profile = { owner, vault, devicePubkey: hex(key.publicKey), strongBoxBacked: key.strongBoxBacked };
  await SecureStore.setItemAsync(PROFILE_KEY, JSON.stringify(profile));

  // Step 2: one wallet approval for both instructions.
  const instructions = [
    initializeVaultInstruction({
      owner,
      mint: USDC_DEVNET,
      tokenProgram: TOKEN_PROGRAM_ID,
      devicePubkey: key.publicKey,
      attestationId,
      floorLimit: FLOOR_LIMIT,
    }),
    ...(firstDeposit > 0n
      ? [depositInstruction({ owner, mint: USDC_DEVNET, tokenProgram: TOKEN_PROGRAM_ID, amount: firstDeposit })]
      : []),
  ];
  const unsigned = buildTransaction(instructions, owner, await latestBlockhash());
  await signAndSend([unsigned.wire]);
  if (!(await waitForAccount(vault))) {
    return { ok: false, reason: "The vault did not appear on chain in time. Check your wallet, then try again." };
  }

  return finish(profile);
}

/** Step 3: the issuer state, from the chain, unless it already exists. */
async function finish(profile: Profile): Promise<Enrolled> {
  const saved = await issuerStore.load();
  if (saved && saved.vault === profile.vault) return { ok: true, state: saved, profile };
  const { account, view } = await readChain(profile.vault);
  if (hex(account.devicePubkey) !== profile.devicePubkey) {
    return { ok: false, reason: "The vault on chain is enrolled to a different key than this phone holds." };
  }
  const state = initialState(profile.vault, unhex(profile.devicePubkey), view);
  await issuerStore.save(state);
  return { ok: true, state, profile };
}

/** Lock more collateral. Returns once the wallet has sent it. */
export async function deposit(owner: string, amount: bigint): Promise<void> {
  const unsigned = buildTransaction(
    [depositInstruction({ owner, mint: USDC_DEVNET, tokenProgram: TOKEN_PROGRAM_ID, amount })],
    owner,
    await latestBlockhash(),
  );
  await signAndSend([unsigned.wire]);
}

/**
 * Refresh from the chain. Frees the amounts of vouchers that settled or
 * expired, and never moves the counter backwards.
 */
export async function sync(): Promise<IssuerState> {
  const state = await issuerStore.load();
  if (!state) throw new Error("This phone is not enrolled.");
  const { view } = await readChain(state.vault);
  const next = applyChain(state, view);
  await issuerStore.save(next);
  return next;
}
