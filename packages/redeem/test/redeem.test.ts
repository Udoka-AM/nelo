/**
 * The redemption transaction.
 *
 * The golden vectors come from the program's own Anchor-generated builders
 * (programs/nelo_vault/tests/tx_vectors.rs), so matching them is matching the
 * program — not matching this file's author's reading of it. Everything else
 * here covers what the vectors cannot: that the address derivation agrees with
 * the runtime beyond the handful of addresses in the vectors, that the builder
 * refuses what would only fail later on chain, and that the result fits in a
 * transaction a wallet will actually send.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { p256 } from "@noble/curves/p256";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getTransactionEncoder,
  isOffCurveAddress,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
} from "@solana/kit";
import { decode, encode, encodeBase58, signedMessage } from "@nelo/voucher";
import { buildTransaction, depositInstruction, initializeVaultInstruction, vaultAddress } from "../src/index.ts";
import {
  AccountRole,
  findProgramAddress,
  isOnCurve,
  lowS,
  NELO_VAULT_PROGRAM_ID,
  precompileInstructionData,
  REDEEM_VOUCHER_DISCRIMINATOR,
  redeemInstructionData,
  redeemInstructions,
  SECP256R1_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  type Instruction,
} from "../src/index.ts";

interface Vectors {
  transactions: {
    name: string;
    input: { packetHex: string; payer: string; mint: string; tokenProgram: string };
    precompile: { programId: string; dataHex: string };
    redeem: {
      programId: string;
      dataHex: string;
      accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
    };
  }[];
  curve: { hex: string; onCurve: boolean }[];
}

const VECTORS: Vectors = JSON.parse(
  readFileSync(new URL("../vectors/redeem-v1.json", import.meta.url), "utf8"),
);

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

const P256_ORDER = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551");

function roleOf(meta: { isSigner: boolean; isWritable: boolean }) {
  return ((meta.isSigner ? 2 : 0) | (meta.isWritable ? 1 : 0)) as AccountRole;
}

function inputOf(v: Vectors["transactions"][number]) {
  return { ...v.input, voucher: unhex(v.input.packetHex) };
}

/** Deterministic bytes, so a failure reproduces. */
function* bytes(seed: number, count: number, len = 32) {
  let x = seed >>> 0 || 1;
  for (let n = 0; n < count; n++) {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      out[i] = x & 0xff;
    }
    yield out;
  }
}

// ---- matches the program, byte for byte ----

test("the vectors hold every case the Rust side generates", () => {
  // An empty or truncated file would make every loop below vacuous.
  assert.deepEqual(
    VECTORS.transactions.map((v) => v.name),
    ["merchant_broadcasts", "relayer_token_2022"],
  );
  assert.ok(VECTORS.curve.length >= 60);
  assert.ok(VECTORS.curve.some((c) => c.onCurve) && VECTORS.curve.some((c) => !c.onCurve));
});

for (const v of VECTORS.transactions) {
  test(`${v.name}: precompile instruction matches the program's writer`, () => {
    const [precompile] = redeemInstructions(inputOf(v));
    assert.equal(precompile.programAddress, v.precompile.programId);
    assert.deepEqual(precompile.accounts, []);
    assert.equal(hex(precompile.data), v.precompile.dataHex);
  });

  test(`${v.name}: redeem instruction data matches Anchor's`, () => {
    const [, redeem] = redeemInstructions(inputOf(v));
    assert.equal(redeem.programAddress, v.redeem.programId);
    assert.equal(hex(redeem.data), v.redeem.dataHex);
  });

  test(`${v.name}: redeem accounts match Anchor's, in order, with roles`, () => {
    const [, redeem] = redeemInstructions(inputOf(v));
    assert.deepEqual(
      redeem.accounts,
      v.redeem.accounts.map((a) => ({ address: a.pubkey, role: roleOf(a) })),
    );
  });

  test(`${v.name}: a decoded voucher builds the same bytes as the packet`, () => {
    const fromPacket = redeemInstructions(inputOf(v));
    const fromVoucher = redeemInstructions({
      ...inputOf(v),
      voucher: decode(unhex(v.input.packetHex)),
    });
    assert.deepEqual(fromVoucher, fromPacket);
  });
}

test("the discriminator is the one Anchor generated", () => {
  for (const v of VECTORS.transactions) {
    assert.equal(hex(REDEEM_VOUCHER_DISCRIMINATOR), v.redeem.dataHex.slice(0, 16));
  }
});

test("the merchant's case lists the same key as payer and as merchant", () => {
  // Payer and merchant are one key when the merchant broadcasts, which is the
  // usual case. Anchor still wants it in both positions; deduplicating it here
  // shifts every account after it by one.
  const v = VECTORS.transactions.find((t) => t.name === "merchant_broadcasts")!;
  const [, redeem] = redeemInstructions(inputOf(v));
  assert.equal(redeem.accounts.length, 11);
  assert.equal(redeem.accounts[0]!.address, redeem.accounts[4]!.address);
  assert.equal(redeem.accounts[0]!.role, AccountRole.WRITABLE_SIGNER);
  assert.equal(redeem.accounts[4]!.role, AccountRole.READONLY);
});

test("the token program is a seed: Token-2022 moves both token accounts", () => {
  const v = VECTORS.transactions.find((t) => t.name === "relayer_token_2022")!;
  const [, right] = redeemInstructions(inputOf(v));
  const [, wrong] = redeemInstructions({ ...inputOf(v), tokenProgram: TOKEN_PROGRAM_ID });
  assert.notEqual(wrong.accounts[5]!.address, right.accounts[5]!.address);
  assert.notEqual(wrong.accounts[6]!.address, right.accounts[6]!.address);
});

// ---- address derivation agrees with the runtime ----

test("on-curve verdicts match curve25519-dalek, awkward encodings included", () => {
  for (const c of VECTORS.curve) {
    assert.equal(isOnCurve(unhex(c.hex)), c.onCurve, c.hex);
  }
});

test("on-curve verdicts match @solana/addresses on arbitrary bytes", () => {
  for (const b of bytes(7, 400)) {
    const kit = !isOffCurveAddress(address(encodeBase58(b)));
    assert.equal(isOnCurve(b), kit, hex(b));
  }
});

test("program addresses match @solana/addresses, bump included", async () => {
  const program = NELO_VAULT_PROGRAM_ID;
  let n = 0;
  for (const seed of bytes(11, 120)) {
    const seeds = [new TextEncoder().encode("vault"), seed.slice(0, (n++ % 32) + 1)];
    const [expected, expectedBump] = await getProgramDerivedAddress({
      programAddress: address(program),
      seeds,
    });
    const [actual, bump] = findProgramAddress(seeds, program);
    assert.equal(actual, expected);
    assert.equal(bump, expectedBump);
  }
});

test("some of those derivations had to skip an on-curve bump", () => {
  // Otherwise the test above never exercised the search, only the first hash.
  let skipped = 0;
  for (const seed of bytes(11, 120)) {
    if (findProgramAddress([seed], NELO_VAULT_PROGRAM_ID)[1] < 255) skipped++;
  }
  assert.ok(skipped > 10, `only ${skipped} of 120 needed a lower bump`);
});

test("the voucher's vault is the vault PDA of its owner", () => {
  // The vector's vault is derived from owner 0x44…44 by the Rust side.
  const v = VECTORS.transactions.find((t) => t.name === "merchant_broadcasts")!;
  const [vault] = findProgramAddress(
    [new TextEncoder().encode("vault"), new Uint8Array(32).fill(0x44)],
    NELO_VAULT_PROGRAM_ID,
  );
  assert.equal(vault, v.redeem.accounts[1]!.pubkey);
});

test("seeds past the runtime's limits are refused", () => {
  assert.throws(() => findProgramAddress([new Uint8Array(33)], NELO_VAULT_PROGRAM_ID), /at most 32/);
  assert.throws(
    () => findProgramAddress(Array.from({ length: 16 }, () => new Uint8Array(1)), NELO_VAULT_PROGRAM_ID),
    /at most 15 seeds/,
  );
});

// ---- low-S ----

test("a high-S signature is folded, and builds what the low-S one does", () => {
  const v = VECTORS.transactions[0]!;
  const packet = unhex(v.input.packetHex);
  const voucher = decode(packet);
  let s = 0n;
  for (let k = 32; k < 64; k++) s = (s << 8n) | BigInt(voucher.signature[k]!);
  let high = P256_ORDER - s;
  const highSig = voucher.signature.slice();
  for (let k = 63; k >= 32; k--) {
    highSig[k] = Number(high & 0xffn);
    high >>= 8n;
  }
  // The high-S form is a real signature over the same message — this is the
  // voucher a merchant takes offline and then cannot settle.
  const msg = signedMessage(voucher);
  assert.ok(p256.verify(highSig, msg, voucher.devicePubkey, { prehash: true, lowS: false }));
  assert.ok(!p256.verify(highSig, msg, voucher.devicePubkey, { prehash: true, lowS: true }));

  const [precompile] = redeemInstructions({
    ...inputOf(v),
    voucher: encode({ ...voucher, signature: highSig }),
  });
  assert.equal(hex(precompile.data), v.precompile.dataHex);
});

test("a low-S signature passes through untouched", () => {
  const sig = decode(unhex(VECTORS.transactions[0]!.input.packetHex)).signature;
  assert.deepEqual(lowS(sig), sig);
  assert.notEqual(lowS(sig), sig, "a copy, not the caller's buffer");
});

// ---- refusals: what would otherwise fail on chain, later, less clearly ----

test("a token program that is neither SPL Token nor Token-2022 is refused", () => {
  const v = VECTORS.transactions[0]!;
  assert.throws(
    () => redeemInstructions({ ...inputOf(v), tokenProgram: NELO_VAULT_PROGRAM_ID }),
    /not a token program/,
  );
  // And both real ones are accepted.
  redeemInstructions({ ...inputOf(v), tokenProgram: TOKEN_PROGRAM_ID });
  redeemInstructions({ ...inputOf(v), tokenProgram: TOKEN_2022_PROGRAM_ID });
});

test("an uncompressed device key is refused", () => {
  const msg = new Uint8Array(105);
  const key = new Uint8Array(33);
  for (const prefix of [0x02, 0x03]) {
    key[0] = prefix;
    precompileInstructionData(msg, new Uint8Array(64), key);
  }
  key[0] = 0x04;
  assert.throws(() => precompileInstructionData(msg, new Uint8Array(64), key), /compressed SEC1/);
});

test("wrong-length signatures and keys are refused", () => {
  const key = new Uint8Array(33).fill(2);
  assert.throws(
    () => precompileInstructionData(new Uint8Array(105), new Uint8Array(63), key),
    /signature must be 64/,
  );
  assert.throws(
    () => precompileInstructionData(new Uint8Array(105), new Uint8Array(64), key.slice(0, 32)),
    /device key must be 33/,
  );
});

test("redeem data takes exactly the 105 signed bytes", () => {
  assert.equal(redeemInstructionData(new Uint8Array(105)).length, 113);
  assert.throws(() => redeemInstructionData(new Uint8Array(104)), /105 bytes/);
  assert.throws(() => redeemInstructionData(new Uint8Array(202)), /105 bytes/);
});

test("a payer or mint that is not an address is refused", () => {
  const v = VECTORS.transactions[0]!;
  assert.throws(() => redeemInstructions({ ...inputOf(v), payer: "1111" }), /not a Solana address/);
  assert.throws(() => redeemInstructions({ ...inputOf(v), mint: "abc" }), /not a Solana address/);
});

// ---- fits in a transaction a wallet will send ----

function compiled(ixs: readonly Instruction[], payer: string) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(payer), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: encodeBase58(new Uint8Array(32).fill(9)) as Blockhash,
          lastValidBlockHeight: 0n,
        },
        m,
      ),
    // Structurally kit's instruction shape; only the address brand differs.
    (m) => appendTransactionMessageInstructions(ixs as never, m),
  );
  return compileTransaction(message);
}

for (const v of VECTORS.transactions) {
  test(`${v.name}: compiles under the packet limit with the precompile first`, () => {
    const ixs = redeemInstructions(inputOf(v));
    const tx = compiled(ixs, v.input.payer);
    const size = getTransactionEncoder().encode(tx).length;
    assert.ok(size <= 1232, `${size} bytes`);

    // Kit reorders the account table, so read instruction 0 back out of the
    // compiled message rather than trusting the order it was handed.
    const decoded = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    // Kit 7 also decodes v1 messages, which carry instructions differently.
    if (!("instructions" in decoded)) throw new Error(`compiled as v${decoded.version}`);
    const programOf = (i: number) =>
      decoded.staticAccounts[decoded.instructions[i]!.programAddressIndex];
    assert.equal(decoded.instructions.length, 2);
    assert.equal(programOf(0), SECP256R1_PROGRAM_ID);
    assert.equal(programOf(1), NELO_VAULT_PROGRAM_ID);
    assert.equal(hex(new Uint8Array(decoded.instructions[0]!.data!)), v.precompile.dataHex);
    assert.equal(hex(new Uint8Array(decoded.instructions[1]!.data!)), v.redeem.dataHex);
  });
}

// ---- enrolment and deposit, against Anchor's own builders ----

const E = (VECTORS as unknown as { enrolment: unknown }).enrolment as {
  input: Record<string, string>;
  initializeVault: { programId: string; dataHex: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[] };
  deposit: { programId: string; dataHex: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[] };
};

test("initialize_vault matches Anchor: data, accounts, roles", () => {
  const ix = initializeVaultInstruction({
    owner: E.input.owner!,
    mint: E.input.mint!,
    tokenProgram: TOKEN_PROGRAM_ID,
    devicePubkey: unhex(E.input.devicePubkeyHex!),
    attestationId: unhex(E.input.attestationIdHex!),
    floorLimit: BigInt(E.input.floorLimit!),
  });
  assert.equal(ix.programAddress, E.initializeVault.programId);
  assert.equal(hex(ix.data), E.initializeVault.dataHex);
  assert.deepEqual(ix.accounts, E.initializeVault.accounts.map((a) => ({ address: a.pubkey, role: roleOf(a) })));
});

test("deposit matches Anchor: data, accounts, roles", () => {
  const ix = depositInstruction({
    owner: E.input.owner!,
    mint: E.input.mint!,
    tokenProgram: TOKEN_PROGRAM_ID,
    amount: BigInt(E.input.amount!),
  });
  assert.equal(hex(ix.data), E.deposit.dataHex);
  assert.deepEqual(ix.accounts, E.deposit.accounts.map((a) => ({ address: a.pubkey, role: roleOf(a) })));
});

test("the vault is the owner's PDA, as the program derives it", () => {
  assert.equal(vaultAddress(E.input.owner!), E.initializeVault.accounts[1]!.pubkey);
});

test("enrolment refuses an uncompressed key, a short attestation id, and a zero deposit", () => {
  const base = {
    owner: E.input.owner!,
    mint: E.input.mint!,
    tokenProgram: TOKEN_PROGRAM_ID,
    devicePubkey: unhex(E.input.devicePubkeyHex!),
    attestationId: unhex(E.input.attestationIdHex!),
    floorLimit: 1n,
  };
  const uncompressed = unhex(E.input.devicePubkeyHex!);
  uncompressed[0] = 4;
  assert.throws(() => initializeVaultInstruction({ ...base, devicePubkey: uncompressed }), /compressed/);
  assert.throws(() => initializeVaultInstruction({ ...base, attestationId: new Uint8Array(31) }), /32 bytes/);
  assert.throws(() => depositInstruction({ ...base, amount: 0n }), /more than zero/);
});

test("enrolment and deposit fit one transaction for the wallet to sign", () => {
  const owner = E.input.owner!;
  const u = buildTransaction(
    [
      initializeVaultInstruction({
        owner,
        mint: E.input.mint!,
        tokenProgram: TOKEN_PROGRAM_ID,
        devicePubkey: unhex(E.input.devicePubkeyHex!),
        attestationId: unhex(E.input.attestationIdHex!),
        floorLimit: 1n,
      }),
      depositInstruction({ owner, mint: E.input.mint!, tokenProgram: TOKEN_PROGRAM_ID, amount: 1n }),
    ],
    owner,
    { blockhash: encodeBase58(new Uint8Array(32).fill(9)), lastValidBlockHeight: 1n },
  );
  assert.ok(u.wire.length <= 1232);
});
