/**
 * The enrolment cache. The layouts are checked against bytes the program's own
 * serializer produced; everything after that is about the cache never lying to
 * the offline check — about which key counts, or which vaults are frozen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { p256 } from "@noble/curves/p256";
import { accept } from "@nelo/accept";
import { encode, encodeBase58, signedMessage, decodeBase58 } from "@nelo/voucher";
import { NELO_VAULT_PROGRAM_ID, riskConfigAddress } from "@nelo/redeem";
import {
  applySnapshot,
  decodeRiskConfig,
  decodeVault,
  emptyCache,
  fetchAll,
  fetchSome,
  fromRecord,
  lookup,
  RISK_CONFIG_DISCRIMINATOR,
  RISK_CONFIG_SPACE,
  toRecord,
  VAULT_DISCRIMINATOR,
  VAULT_MINT_OFFSET,
  VAULT_SPACE,
  type Rpc,
  type Snapshot,
} from "../src/index.ts";

const V = JSON.parse(readFileSync(new URL("../vectors/accounts-v1.json", import.meta.url), "utf8"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function fieldsOf(a: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(a)) {
    out[k] = v instanceof Uint8Array ? hex(v) : typeof v === "bigint" ? v.toString() : v;
  }
  return out;
}

// ---- layouts ----

test("the vectors hold both vault cases and the risk config", () => {
  assert.equal(V.vaults.length, 2);
  assert.ok(V.riskConfig.dataHex.length > 0);
});

test("discriminators and sizes are the program's", () => {
  assert.equal(hex(VAULT_DISCRIMINATOR), V.vaultDiscriminatorHex);
  assert.equal(hex(RISK_CONFIG_DISCRIMINATOR), V.riskConfigDiscriminatorHex);
  assert.equal(VAULT_SPACE, V.vaultSpace);
  assert.equal(RISK_CONFIG_SPACE, V.riskConfigSpace);
});

for (const c of V.vaults) {
  test(`${c.name}: every vault field decodes to the program's value`, () => {
    assert.deepEqual(fieldsOf(decodeVault(unhex(c.dataHex)) as never), c.fields);
  });
}

test("the risk config decodes to the program's values", () => {
  assert.deepEqual(fieldsOf(decodeRiskConfig(unhex(V.riskConfig.dataHex)) as never), V.riskConfig.fields);
});

test("the mint filter offset points at the mint", () => {
  const c = V.vaults[0];
  const data = unhex(c.dataHex);
  assert.equal(encodeBase58(data.slice(VAULT_MINT_OFFSET, VAULT_MINT_OFFSET + 32)), c.fields.mint);
});

test("an account that is not a vault is refused, not misread", () => {
  assert.throws(() => decodeVault(unhex(V.riskConfig.dataHex)), /not a vault/);
  assert.throws(() => decodeRiskConfig(unhex(V.vaults[0].dataHex)), /not a risk config/);
  assert.throws(() => decodeVault(new Uint8Array(4)), /not a vault/);
});

test("truncated account data is refused", () => {
  const data = unhex(V.vaults[0].dataHex).slice(0, VAULT_SPACE - 1);
  assert.throws(() => decodeVault(data), /account data ends/);
});

// ---- sync ----

const MINT = V.vaults[0].fields.mint as string;

function rpcAccount(dataHex: string, owner = NELO_VAULT_PROGRAM_ID) {
  return { data: [b64(unhex(dataHex)), "base64"], owner, lamports: 1, executable: false };
}

function fakeRpc(answers: Record<string, (params: unknown[]) => unknown>) {
  const calls: { method: string; params: unknown[] }[] = [];
  const rpc: Rpc = async (method, params) => {
    calls.push({ method, params });
    const answer = answers[method];
    if (!answer) throw new Error(`unexpected ${method}`);
    return answer(params);
  };
  return { rpc, calls };
}

const VAULT_A = encodeBase58(new Uint8Array(32).fill(0xa1));
const VAULT_B = encodeBase58(new Uint8Array(32).fill(0xb2));

test("a full sync asks for exactly the vaults for this mint, and the risk config", async () => {
  const { rpc, calls } = fakeRpc({
    getProgramAccounts: () => [{ pubkey: VAULT_A, account: rpcAccount(V.vaults[0].dataHex) }],
    getAccountInfo: () => ({ value: rpcAccount(V.riskConfig.dataHex) }),
  });
  const { snapshot, skipped } = await fetchAll(rpc, { mint: MINT, now: 100 });

  assert.deepEqual(calls[0], {
    method: "getProgramAccounts",
    params: [
      NELO_VAULT_PROGRAM_ID,
      {
        encoding: "base64",
        commitment: "confirmed",
        filters: [
          { dataSize: 213 },
          { memcmp: { offset: 0, bytes: encodeBase58(unhex(V.vaultDiscriminatorHex)) } },
          { memcmp: { offset: 40, bytes: MINT } },
        ],
      },
    ],
  });
  assert.deepEqual(calls[1], {
    method: "getAccountInfo",
    params: [riskConfigAddress(), { encoding: "base64", commitment: "confirmed" }],
  });
  assert.equal(snapshot.full, true);
  assert.deepEqual(snapshot.vaults.map((v) => v.address), [VAULT_A]);
  assert.equal(snapshot.risk?.kBps, V.riskConfig.fields.kBps);
  assert.deepEqual(skipped, []);
});

test("an account owned by another program is skipped, and says why", async () => {
  const { rpc } = fakeRpc({
    getProgramAccounts: () => [
      { pubkey: VAULT_A, account: rpcAccount(V.vaults[0].dataHex, "11111111111111111111111111111111") },
      { pubkey: VAULT_B, account: rpcAccount(V.vaults[0].dataHex) },
    ],
    getAccountInfo: () => ({ value: rpcAccount(V.riskConfig.dataHex) }),
  });
  const { snapshot, skipped } = await fetchAll(rpc, { mint: MINT, now: 1 });
  assert.deepEqual(snapshot.vaults.map((v) => v.address), [VAULT_B]);
  assert.equal(skipped[0]!.address, VAULT_A);
  assert.match(skipped[0]!.reason, /owned by/);
});

test("a vault for a different mint is skipped even if the RPC returns it", async () => {
  const { rpc } = fakeRpc({
    getProgramAccounts: () => [{ pubkey: VAULT_A, account: rpcAccount(V.vaults[1].dataHex) }],
    getAccountInfo: () => ({ value: null }),
  });
  const { snapshot, skipped } = await fetchAll(rpc, { mint: MINT, now: 1 });
  assert.deepEqual(snapshot.vaults, []);
  assert.match(skipped[0]!.reason, /mint/);
  assert.equal(snapshot.risk, null, "no risk config on chain yet reads as null, not a throw");
});

test("a targeted refresh names its vaults and marks the snapshot partial", async () => {
  const { rpc, calls } = fakeRpc({
    getMultipleAccounts: () => ({ value: [rpcAccount(V.vaults[0].dataHex), null] }),
    getAccountInfo: () => ({ value: rpcAccount(V.riskConfig.dataHex) }),
  });
  const { snapshot, skipped } = await fetchSome(rpc, [VAULT_A, VAULT_B], { now: 5 });
  assert.deepEqual(calls[0]!.params, [[VAULT_A, VAULT_B], { encoding: "base64", commitment: "confirmed" }]);
  assert.equal(snapshot.full, false);
  assert.deepEqual(snapshot.vaults.map((v) => v.address), [VAULT_A]);
  assert.deepEqual(skipped, [{ address: VAULT_B, reason: "no such account" }]);
});

// ---- cache ----

const vaultAccount = decodeVault(unhex(V.vaults[0].dataHex));
const frozenAccount = { ...vaultAccount, status: 1 };
const riskAccount = decodeRiskConfig(unhex(V.riskConfig.dataHex));

function snap(o: Partial<Snapshot>): Snapshot {
  return { syncedAt: 100, vaults: [], risk: riskAccount, full: true, ...o };
}

test("a vault that is not cached cannot be looked up, and nor can anything before the risk config", () => {
  assert.deepEqual(lookup(emptyCache(), VAULT_A), { found: false, missing: "risk" });
  const c = applySnapshot(emptyCache(), snap({ vaults: [] }));
  assert.deepEqual(lookup(c, VAULT_A), { found: false, missing: "vault" });
});

test("a frozen vault comes through as frozen: the cache is the revocation list", () => {
  const c = applySnapshot(emptyCache(), snap({ vaults: [{ address: VAULT_A, account: frozenAccount }] }));
  const l = lookup(c, VAULT_A);
  assert.ok(l.found);
  if (l.found) assert.equal(l.enrolment.status, 1);
});

test("a late, older snapshot never rolls a vault backwards", () => {
  let c = applySnapshot(emptyCache(), snap({ syncedAt: 200, vaults: [{ address: VAULT_A, account: frozenAccount }] }));
  c = applySnapshot(c, snap({ syncedAt: 100, vaults: [{ address: VAULT_A, account: vaultAccount }] }));
  const l = lookup(c, VAULT_A);
  assert.ok(l.found && l.enrolment.status === 1 && l.enrolment.syncedAt === 200, "still frozen");
  assert.equal(c.fullSyncAt, 200);
});

test("a full snapshot drops vaults the chain no longer has; a partial one does not", () => {
  const both = applySnapshot(
    emptyCache(),
    snap({ vaults: [{ address: VAULT_A, account: vaultAccount }, { address: VAULT_B, account: vaultAccount }] }),
  );
  const partial = applySnapshot(both, snap({ syncedAt: 150, full: false, vaults: [{ address: VAULT_A, account: vaultAccount }] }));
  assert.deepEqual([...partial.vaults.keys()].sort(), [VAULT_A, VAULT_B].sort());
  const full = applySnapshot(both, snap({ syncedAt: 150, vaults: [{ address: VAULT_A, account: vaultAccount }] }));
  assert.deepEqual([...full.vaults.keys()], [VAULT_A]);
});

test("the cache survives the round trip to storage exactly", () => {
  const c = applySnapshot(emptyCache(), snap({ vaults: [{ address: VAULT_A, account: decodeVault(unhex(V.vaults[1].dataHex)) }] }));
  const back = fromRecord(JSON.parse(JSON.stringify(toRecord(c))));
  assert.deepEqual(back, c);
});

// ---- end to end: raw account bytes to an offline decision ----

test("a voucher signed by the cached key is taken; one signed by any other key is not", async () => {
  const sk = p256.utils.randomPrivateKey();
  const devicePubkey = p256.getPublicKey(sk, true);

  // The vault as the chain would hold it, with this device enrolled.
  const data = unhex(V.vaults[0].dataHex);
  data.set(devicePubkey, 8 + 32 + 32);
  const vault = VAULT_A;

  const { rpc } = fakeRpc({
    getProgramAccounts: () => [{ pubkey: vault, account: rpcAccount(hex(data)) }],
    getAccountInfo: () => ({ value: rpcAccount(V.riskConfig.dataHex) }),
  });
  const now = 1_789_000_000;
  const { snapshot } = await fetchAll(rpc, { mint: MINT, now });
  const l = lookup(applySnapshot(emptyCache(), snapshot), vault);
  assert.ok(l.found);
  if (!l.found) return;

  const fields = {
    version: 1,
    vault: decodeBase58(vault),
    seq: l.enrolment.seqBase + 1n, // bit 0 of the cached bitmap is set; bit 1 is free
    amount: 1_000_000n,
    remainingAfter: l.enrolment.balance - 1_000_000n,
    merchant: new Uint8Array(32).fill(0x22),
    expiresAt: BigInt(now + 3600),
    salt: new Uint8Array(8),
  };
  const sign = (key: Uint8Array) =>
    encode({
      ...fields,
      signature: p256.sign(signedMessage(fields), key, { prehash: true, lowS: true }).toCompactRawBytes(),
      devicePubkey: p256.getPublicKey(key, true),
    });

  const good = accept({ bytes: sign(sk), enrolment: l.enrolment, risk: l.risk, now });
  assert.equal(good.take, true, good.take ? "" : good.reason);

  const other = accept({ bytes: sign(p256.utils.randomPrivateKey()), enrolment: l.enrolment, risk: l.risk, now });
  assert.equal(other.take, false);
});
