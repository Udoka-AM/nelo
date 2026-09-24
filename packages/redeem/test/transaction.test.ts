/**
 * Signing through the merchant's own wallet. The wallet is simulated with a
 * real ed25519 key, and the ways a real wallet goes wrong — adding a priority
 * fee, not signing, signing with the wrong key — are each refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getTransactionEncoder,
  pipe,
  prependTransactionMessageInstruction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
} from "@solana/kit";
import { encodeBase58 } from "@nelo/voucher";
import {
  buildRedemption,
  checkSigned,
  NELO_VAULT_PROGRAM_ID,
  PACKET_LIMIT,
  redeemInstructions,
  SECP256R1_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type Unsigned,
} from "../src/index.ts";

const V = JSON.parse(readFileSync(new URL("../vectors/redeem-v1.json", import.meta.url), "utf8"));
const PACKET = new Uint8Array(Buffer.from(V.transactions[0].input.packetHex, "hex"));
const MINT = V.transactions[0].input.mint as string;

const SECRET = ed25519.utils.randomPrivateKey();
const PAYER = encodeBase58(ed25519.getPublicKey(SECRET));
const LIFETIME = { blockhash: encodeBase58(new Uint8Array(32).fill(9)), lastValidBlockHeight: 100n };

const input = { voucher: PACKET, payer: PAYER, mint: MINT, tokenProgram: TOKEN_PROGRAM_ID };

/** A wallet: put the fee payer's signature in the first slot of `wire`. */
function walletSigns(unsigned: Unsigned, secret = SECRET, message = unsigned.message, wire = unsigned.wire) {
  const out = new Uint8Array(wire);
  out.set(ed25519.sign(message, secret), 1); // after the compact-u16 signature count
  return out;
}

test("a redemption compiles to one signer, the precompile first, under the packet limit", () => {
  const u = buildRedemption(input, LIFETIME);
  assert.ok(u.wire.length <= PACKET_LIMIT);
  const m = getCompiledTransactionMessageDecoder().decode(u.message);
  assert.equal(m.header.numSignerAccounts, 1);
  assert.equal(m.staticAccounts[0], PAYER, "the merchant pays the fee");
  if (!("instructions" in m)) throw new Error("expected a legacy message");
  assert.equal(m.staticAccounts[m.instructions[0]!.programAddressIndex], SECP256R1_PROGRAM_ID);
  assert.equal(m.staticAccounts[m.instructions[1]!.programAddressIndex], NELO_VAULT_PROGRAM_ID);
});

test("a wallet's honest signature is accepted, and gives the transaction id", () => {
  const u = buildRedemption(input, LIFETIME);
  const c = checkSigned(u, walletSigns(u));
  assert.ok(c.ok, c.ok ? "" : c.reason);
  if (c.ok) assert.equal(c.signature, encodeBase58(ed25519.sign(u.message, SECRET)));
});

test("a wallet that adds a priority fee in front is refused", () => {
  const u = buildRedemption(input, LIFETIME);
  // What such a wallet does: the same instructions, with a ComputeBudget one first.
  const altered = compileTransaction(
    pipe(
      createTransactionMessage({ version: "legacy" }),
      (m) => setTransactionMessageFeePayer(address(PAYER), m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: LIFETIME.blockhash as Blockhash, lastValidBlockHeight: 100n }, m),
      (m) => appendTransactionMessageInstructions(redeemInstructions(input) as never, m),
      (m) =>
        prependTransactionMessageInstruction(
          { programAddress: address("ComputeBudget111111111111111111111111111111"), data: Uint8Array.of(3, 1, 0, 0, 0, 0, 0, 0, 0) },
          m,
        ),
    ),
  );
  const alteredWire = new Uint8Array(getTransactionEncoder().encode(altered));
  const signed = walletSigns(u, SECRET, new Uint8Array(altered.messageBytes), alteredWire);
  const c = checkSigned(u, signed);
  assert.equal(c.ok, false);
  if (!c.ok) assert.match(c.reason, /changed the transaction/);
});

test("an unsigned return, or a signature by another key, is refused", () => {
  const u = buildRedemption(input, LIFETIME);
  const unsigned = checkSigned(u, u.wire);
  assert.equal(unsigned.ok, false);
  if (!unsigned.ok) assert.match(unsigned.reason, /did not sign/);

  const impostor = checkSigned(u, walletSigns(u, ed25519.utils.randomPrivateKey()));
  assert.equal(impostor.ok, false);
  if (!impostor.ok) assert.match(impostor.reason, /does not verify/);
});

test("bytes that are not a transaction are refused", () => {
  const u = buildRedemption(input, LIFETIME);
  const c = checkSigned(u, new Uint8Array(5));
  assert.equal(c.ok, false);
});
