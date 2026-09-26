/**
 * The week-3 gate, rehearsed against a real cluster with the product's own code.
 *
 *   Two phones in airplane mode, a sale completes, both reconnect, it settles,
 *   and the replayed voucher is refused.
 *
 * Nothing here stands in for the product. The payer's vault is opened with
 * `@nelo/redeem`'s builders, as the payer app opens it; the voucher is issued
 * by `@nelo/issue`; the till syncs with `@nelo/enrol`, decides with
 * `@nelo/till`, keeps it in the same SQLite store, and settles with
 * `@nelo/queue` through the relayer in `services/relay`, over HTTP. Two things
 * are stood in for, and only two: the phone's secure element is a software
 * P-256 key, and the phones are this one process. While the phones are
 * "offline", `fetch` is switched off, so anything that reached for the network
 * would fail the run rather than quietly succeed.
 *
 * Then it goes further than the gate: a compromised phone signs a second
 * voucher at the same sequence for another till. That till takes it (offline,
 * it cannot know), and on reconnect the relayer catches it, reports it, the
 * vault freezes, and the stake behind it is slashed into the reserve.
 *
 *   pnpm rehearse                          RPC from ~/.config/nelo/relay.env
 *   pnpm rehearse --rpc http://127.0.0.1:8899
 *   pnpm rehearse --keypair ~/.config/solana/id.json
 *
 * Costs about 0.15 SOL on devnet; what is left in the accounts it creates is
 * sent back at the end. Every run uses fresh wallets and a fresh test mint, so
 * runs never collide. Devnet USDC is not used: its mint authority is Circle's.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { p256 } from "@noble/curves/p256";
import { applySnapshot, emptyCache, fetchAll, fetchSome, jsonRpc, lookup, decodeVault } from "@nelo/enrol";
import { applyChain, chainViewOf, initialState, pay, readMerchantCode, type IssuerState, type IssuerStore } from "@nelo/issue";
import { encodeTransferRequest, formatTokenAmount } from "@nelo/pay";
import { enqueue, relayPrepare, reportConflict as reportToRelay, rpcStatuses, settleOnce, PROGRAM_ERROR_CODES } from "@nelo/queue";
import {
  associatedTokenAddress,
  buildRedemption,
  depositInstruction,
  initializeVaultInstruction,
  riskConfigAddress,
  TOKEN_PROGRAM_ID,
  vaultAddress,
} from "@nelo/redeem";
import { buildRelay, createRelayRpc, feePayerFromSecret, fileLedger } from "@nelo/relay";
import { describeRisk, scan, voucherDb, type SqlDb } from "@nelo/till";
import { decode, decodeBase58, encode, encodeBase58, signedMessage, toQr, type Voucher } from "@nelo/voucher";
import {
  cluster as connect,
  createAccount,
  createAtaIdempotent,
  initializeMint,
  initializeRiskConfig,
  keypairBytes,
  loadKeypair,
  mintAuthority,
  mintTo,
  MINT_LEN,
  newKeypair,
  stake,
  transfer,
} from "./chain.ts";

// ---------------------------------------------------------------------------
// Settings

const { values: args } = parseArgs({
  options: { rpc: { type: "string" }, keypair: { type: "string" } },
});

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

const DECIMALS = 6;
const dollars = (d: number) => BigInt(Math.round(d * 10 ** DECIMALS));
const MINTED = dollars(100);
const COLLATERAL = dollars(20);
const FLOOR_LIMIT = dollars(10);
const SALE = dollars(2.5);
const STAKE_UNITS = 5n;
const OWNER_SOL = 100_000_000n; // 0.1 SOL: two mints, four token accounts, the vault
const RELAY_SOL = 30_000_000n; // 0.03 SOL: fees, two merchants' token accounts, the reserve's

const rpcUrl = args.rpc ?? process.env.REHEARSE_RPC_URL ?? process.env.RELAY_RPC_URL;
if (!rpcUrl) {
  console.error("No RPC. Pass --rpc <url>, or run `pnpm setup:env` so ~/.config/nelo/relay.env has RELAY_RPC_URL.");
  process.exit(1);
}
const keypairPath = (() => {
  const expand = (p: string) => p.replace(/^~(?=\/|$)/, homedir());
  if (args.keypair) return expand(args.keypair);
  if (process.env.REHEARSE_KEYPAIR) return expand(process.env.REHEARSE_KEYPAIR);
  const cli = join(homedir(), ".config/solana/id.json");
  if (existsSync(cli)) return cli;
  if (process.env.RELAY_KEYPAIR) return expand(process.env.RELAY_KEYPAIR);
  console.error("No funding keypair. Pass --keypair <file>: any devnet wallet with ~0.2 SOL.");
  process.exit(1);
})();

// ---------------------------------------------------------------------------
// Reporting

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let explorer = (sig: string) => sig;

function ok(line: string, detail?: string) {
  console.log(`  ✓ ${line}${detail ? `\n      ${detail}` : ""}`);
}
function note(line: string) {
  console.log(`  • ${line}`);
}
function section(title: string) {
  console.log(`\n${title}`);
}
class Failed extends Error {}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Failed(message);
}

/** Anchor's custom error for the instruction at `index`, if that is what `err` is. */
function customError(err: unknown, index: number): number | null {
  const e = err as { InstructionError?: [number, { Custom?: number } | string] } | null;
  if (!e?.InstructionError || e.InstructionError[0] !== index) return null;
  const inner = e.InstructionError[1];
  return typeof inner === "object" && typeof inner.Custom === "number" ? inner.Custom : null;
}

// ---------------------------------------------------------------------------
// Phones

/** The till's own SQLite store, on Node's SQLite instead of expo-sqlite. */
function nodeDb(): SqlDb {
  const d = new DatabaseSync(":memory:");
  return {
    execAsync: async (sql) => void d.exec(sql),
    runAsync: async (sql, ...p) => d.prepare(sql).run(...p),
    getAllAsync: async <T,>(sql: string, ...p: (string | number | null)[]) => d.prepare(sql).all(...p) as T[],
    getFirstAsync: async <T,>(sql: string, ...p: (string | number | null)[]) =>
      (d.prepare(sql).get(...p) as T | undefined) ?? null,
  };
}

const realFetch = globalThis.fetch;
/** Airplane mode, for everything in this process that would use the network. */
function offline<T>(work: () => Promise<T>): Promise<T> {
  globalThis.fetch = (async () => {
    throw new Error("airplane mode: something reached for the network while the phones were offline");
  }) as typeof fetch;
  return work().finally(() => {
    globalThis.fetch = realFetch;
  });
}

const now = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------

async function main() {
  const chain = connect(rpcUrl!);
  const funder = loadKeypair(keypairPath);
  const genesis = await chain.call<string>("getGenesisHash");
  if (genesis === MAINNET_GENESIS) throw new Failed("That RPC is mainnet. The rehearsal runs on devnet or a local validator only.");
  const clusterName = genesis === DEVNET_GENESIS ? "devnet" : "a local validator";
  if (genesis === DEVNET_GENESIS) explorer = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

  console.log(`Nelo gate rehearsal on ${clusterName}`);
  console.log(`  RPC     ${new URL(rpcUrl!).host}`);
  console.log(`  funder  ${funder.address}  (${keypairPath})`);

  const programAccount = await chain.call<{ value: { executable: boolean } | null }>("getAccountInfo", [
    "29QdPRQC8C5v6C8gMcBqtw9T4RxYyZ1wqThkEj3XJeQx",
    { encoding: "base64", dataSlice: { offset: 0, length: 0 } },
  ]);
  check(programAccount.value?.executable, "nelo_vault is not deployed on this cluster.");

  let balance = await chain.lamports(funder.address);
  const needed = Number(OWNER_SOL + RELAY_SOL) + 20_000_000;
  if (balance < needed && genesis !== DEVNET_GENESIS) {
    const sig = await chain.call<string>("requestAirdrop", [funder.address, 2_000_000_000]);
    await chain.confirm(sig);
    balance = await chain.lamports(funder.address);
  }
  check(
    balance >= needed,
    `The funder holds ${balance / 1e9} SOL and the run needs about ${needed / 1e9}. ` +
      `Top it up at https://faucet.solana.com (address ${funder.address}).`,
  );

  // Fresh every run: the vault is seeded by its owner, so a new owner is a new vault.
  const owner = newKeypair();
  const merchantA = newKeypair();
  const merchantB = newKeypair();
  const relayPayer = newKeypair();
  const deviceKey = p256.utils.randomPrivateKey();
  const devicePubkey = p256.getPublicKey(deviceKey, true);
  const secureElement = async (m: Uint8Array) => p256.sign(m, deviceKey, { prehash: true, lowS: true }).toCompactRawBytes();
  const vault = vaultAddress(owner.address);

  // -------------------------------------------------------------------------
  section("1. Setup, online");

  await chain.send(
    [transfer(funder.address, owner.address, OWNER_SOL), transfer(funder.address, relayPayer.address, RELAY_SOL)],
    [funder],
  );
  ok(`funded the payer's wallet and the relayer's fee payer`, `payer ${owner.address}\n      relay ${relayPayer.address}`);

  const rent = BigInt(await chain.call<number>("getMinimumBalanceForRentExemption", [MINT_LEN]));
  const mint = newKeypair();
  await chain.send(
    [
      createAccount(owner.address, mint.address, rent, MINT_LEN, TOKEN_PROGRAM_ID),
      initializeMint(mint.address, owner.address, DECIMALS),
      createAtaIdempotent(owner.address, owner.address, mint.address),
      mintTo(mint.address, associatedTokenAddress(owner.address, mint.address, TOKEN_PROGRAM_ID), owner.address, MINTED),
    ],
    [owner, mint],
  );
  ok(`test dollar mint, ${formatTokenAmount(MINTED)} in the payer's wallet`, `mint ${mint.address}`);

  // The risk config is a singleton: on devnet it is already there, on a fresh
  // validator this run creates it with a stake mint it controls.
  let stakeMint: string;
  let canStake = false;
  const riskData = await chain.account(riskConfigAddress());
  if (!riskData) {
    const sm = newKeypair();
    await chain.send(
      [
        createAccount(owner.address, sm.address, rent, MINT_LEN, TOKEN_PROGRAM_ID),
        // The funder, not this run's throwaway owner, so later runs on the same
        // cluster can mint stake too.
        initializeMint(sm.address, funder.address, DECIMALS),
        initializeRiskConfig(owner.address, sm.address, {
          authority: funder.address,
          kBps: 10_000,
          stakeReference: dollars(100),
          hardCap: dollars(1000),
          stakePrice: 0n,
          haircutBps: 5_000,
          unstakeCooldown: 86_400n,
        }),
      ],
      [owner, sm],
    );
    stakeMint = sm.address;
    canStake = true;
    ok("risk config created (none on this cluster yet)");
  } else {
    // stake_mint follows the 8-byte discriminator and the authority.
    stakeMint = encodeBase58(riskData.subarray(40, 72));
    const smData = await chain.account(stakeMint);
    const authority = smData ? mintAuthority(smData) : null;
    canStake = authority === funder.address;
    note(
      canStake
        ? `risk config present; its stake mint is yours to mint, so the stake can be slashed`
        : `risk config present; its stake mint's authority is ${authority ?? "none"}, not the funder, ` +
            `so this run stakes nothing and the slash step is skipped`,
    );
  }

  await chain.send(
    [
      initializeVaultInstruction({
        owner: owner.address,
        mint: mint.address,
        tokenProgram: TOKEN_PROGRAM_ID,
        devicePubkey,
        attestationId: new Uint8Array(32).fill(9),
        floorLimit: FLOOR_LIMIT,
      }),
      depositInstruction({ owner: owner.address, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ID, amount: COLLATERAL }),
    ],
    [owner],
  );
  ok(`vault opened with the phone's key enrolled, ${formatTokenAmount(COLLATERAL)} locked`, `vault ${vault}`);

  let staked = 0n;
  if (canStake) {
    const smData = (await chain.account(stakeMint))!;
    const stakeDecimals = smData[44]!;
    staked = STAKE_UNITS * 10n ** BigInt(stakeDecimals);
    await chain.send(
      [
        createAtaIdempotent(owner.address, owner.address, stakeMint),
        mintTo(stakeMint, associatedTokenAddress(owner.address, stakeMint, TOKEN_PROGRAM_ID), funder.address, staked),
        stake(owner.address, stakeMint, staked),
      ],
      [owner, funder],
    );
    ok(`${STAKE_UNITS} stake tokens staked behind the vault`);
  }

  // The payer's phone reads its vault once, as the payer app does after enrolling.
  const payerRead = await fetchSome(jsonRpc(chain.url), [vault], { now: now(), mint: mint.address });
  const payerCache = applySnapshot(emptyCache(), payerRead.snapshot);
  const payerFound = lookup(payerCache, vault);
  check(payerFound.found, "the payer's phone could not read its own vault");
  const vaultAccount = payerRead.snapshot.vaults.find((v) => v.address === vault)!.account;
  let issuer: IssuerState = initialState(vault, devicePubkey, chainViewOf(vault, vaultAccount, payerFound.risk, now()));
  const issuerStore: IssuerStore = { load: async () => issuer, save: async (s) => void (issuer = s) };
  ok(`payer's phone synced: it may spend up to ${formatTokenAmount(issuer.chain.limit)} offline`);

  // Both tills sync the payer list, as the merchant app does on start.
  const tillA = voucherDb(async () => nodeDb());
  const tillB = voucherDb(async () => nodeDb());
  for (const till of [tillA, tillB]) {
    const { snapshot } = await fetchAll(jsonRpc(chain.url), { mint: mint.address, now: now() });
    await till.saveCache(applySnapshot(await till.loadCache(), snapshot));
  }
  ok("both tills synced the payer list");

  // The relayer, in this process, over HTTP, with its own ledger and fee payer.
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "nelo-rehearse-")), "relay-ledger.json");
  const relayNow = now;
  const relay = buildRelay({
    now: relayNow,
    deps: {
      rpc: createRelayRpc(chain.url, realFetch),
      feePayer: feePayerFromSecret(keypairBytes(relayPayer)),
      ledger: fileLedger(ledgerPath, new Date().toISOString().slice(0, 10)),
      config: {
        mint: mint.address,
        limits: { budgetLamports: Number(RELAY_SOL), maxPerVault: 20, allowedMints: [mint.address], sponsorNewAccounts: true },
      },
    },
  });
  await relay.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (relay.app.server.address() as { port: number }).port;
  const relayer = { url: `http://127.0.0.1:${port}`, fetch: realFetch as never };
  ok(`relayer listening on ${relayer.url}`);

  try {
    // -----------------------------------------------------------------------
    section("2. Airplane mode: a sale at till A");

    await offline(async () => {
      const request = encodeTransferRequest({
        recipient: merchantA.address,
        amount: formatTokenAmount(SALE, DECIMALS).replace(/[^\d.]/g, ""),
        splToken: mint.address,
        label: "Nelo",
      });
      const read = readMerchantCode(request, mint.address);
      check(read.ok, `the payer's phone could not read till A's code: ${read.ok ? "" : read.reason}`);
      check(read.amount === SALE, `the payer read ${read.amount}, not ${SALE}`);
      const issued = await pay(issuerStore, secureElement, { merchant: read.merchant, amount: read.amount, now: now() }, (n) =>
        crypto.getRandomValues(new Uint8Array(n)),
      );
      check(issued.ok, `the payer's phone would not pay: ${issued.ok ? "" : issued.reason}`);
      ok(`payer signed a voucher for ${formatTokenAmount(SALE)}, seq ${decode(issued.packet).seq}`);
      const qr = toQr(issued.packet);

      const result = scan({ text: qr, cache: await tillA.loadCache(), merchant: merchantA.address, charged: SALE, queued: await tillA.queue.all(), now: now() });
      check(result.kind === "take", `till A would not take it: ${JSON.stringify(result.kind === "refused" ? result.reason : result.kind)}`);
      const added = enqueue(() => undefined, result.packet, Date.now());
      check(added.kind === "added", "till A could not queue it");
      await tillA.add(added.entry, 250_000n, "NGN");
      ok("till A checked it offline and took it; the goods go");

      const again = scan({ text: qr, cache: await tillA.loadCache(), merchant: merchantA.address, charged: SALE, queued: await tillA.queue.all(), now: now() });
      check(again.kind === "refused", `the same code shown again was ${again.kind}, not refused`);
      ok("the same code shown again at till A: refused", again.reason);
    });
    const packetA = (await tillA.queue.all())[0]!.packet;

    // -----------------------------------------------------------------------
    section("3. Reconnect: till A settles through the relayer");

    const merchantAToken = associatedTokenAddress(merchantA.address, mint.address, TOKEN_PROGRAM_ID);
    const vaultToken = associatedTokenAddress(vault, mint.address, TOKEN_PROGRAM_ID);
    const vaultBefore = await chain.tokenBalance(vaultToken);
    const statuses = rpcStatuses(chain.url, realFetch as never);
    let settledSig: string | null = null;
    for (let round = 0; round < 60 && !settledSig; round++) {
      const report = await settleOnce(tillA.queue, { now: () => Date.now(), prepare: relayPrepare(relayer), statuses });
      check(!report.offline, "till A could not reach the relayer");
      check(report.refused.length === 0 && report.held.length === 0, `the voucher was not settled: ${JSON.stringify([...report.refused, ...report.held].map((e) => e.status))}`);
      settledSig = report.settled[0]?.settledSignature ?? null;
      if (!settledSig) await sleep(1000);
    }
    check(settledSig, "the voucher did not settle within a minute");
    const paidA = await chain.tokenBalance(merchantAToken);
    check(paidA === SALE, `merchant A holds ${paidA}, expected ${SALE}`);
    check((await chain.tokenBalance(vaultToken)) === vaultBefore - SALE, "the vault did not pay out exactly the sale");
    ok(`settled: merchant A was paid ${formatTokenAmount(SALE)}, with no SOL of their own`, explorer(settledSig));
    check((await chain.lamports(merchantA.address)) === 0, "merchant A was given SOL");

    // -----------------------------------------------------------------------
    section("4. The replayed voucher");

    const asked = await relayPrepare(relayer)({ ...(await tillA.queue.all())[0]!, packet: packetA });
    check("signature" in asked && asked.signature === settledSig, "asked again, the relayer did not answer with the first transaction");
    ok("asked again, the relayer answers with the transaction that already landed, and sends nothing");

    const lifetime = await chain.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
    const direct = buildRedemption(
      { voucher: packetA, payer: funder.address, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ID },
      { blockhash: lifetime.value.blockhash, lastValidBlockHeight: BigInt(lifetime.value.lastValidBlockHeight) },
    );
    const wire = new Uint8Array(direct.wire);
    wire.set(funder.sign(direct.message), 1);
    const replay = await chain.call<string>("sendTransaction", [Buffer.from(wire).toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }]).then(
      () => ({ ok: true as const }),
      (e: { err?: unknown }) => ({ ok: false as const, err: e.err }),
    );
    check(!replay.ok, "THE REPLAYED VOUCHER WAS ACCEPTED BY THE PROGRAM");
    const code = customError(replay.err, 1);
    // Either is the replay window: already redeemed inside it, or behind its
    // base, which moves past a sequence once everything below it is redeemed.
    const byWindow =
      code === PROGRAM_ERROR_CODES.SequenceAlreadyRedeemed ? "SequenceAlreadyRedeemed" : code === PROGRAM_ERROR_CODES.SequenceTooOld ? "SequenceTooOld" : null;
    check(byWindow, `refused, but not by the replay window: ${JSON.stringify(replay.err)}`);
    ok(`sent straight to the program, bypassing the relayer: refused, ${byWindow}`);
    check((await chain.tokenBalance(merchantAToken)) === SALE, "merchant A's balance moved on the replay");

    // -----------------------------------------------------------------------
    section("5. A compromised phone: the same sequence, spent again at till B");

    const first = decode(packetA);
    // Signed straight with the key, as a phone whose issuer had been tampered with would.
    const { signature: _s, devicePubkey: _d, ...signedFields } = first;
    const fields = { ...signedFields, merchant: decodeBase58(merchantB.address), salt: crypto.getRandomValues(new Uint8Array(8)) };
    const msg = signedMessage(fields);
    const packetB = encode({ ...fields, signature: await secureElement(msg), devicePubkey } as Voucher);

    await offline(async () => {
      const result = scan({ text: toQr(packetB), cache: await tillB.loadCache(), merchant: merchantB.address, charged: SALE, queued: await tillB.queue.all(), now: now() });
      check(result.kind === "take", `till B refused it offline (${result.kind}); the rehearsal expects it to be caught on chain`);
      const added = enqueue(() => undefined, result.packet, Date.now());
      check(added.kind === "added", "till B could not queue it");
      await tillB.add(added.entry, 250_000n, "NGN");
      ok(`till B took it offline: it has never seen seq ${first.seq} and cannot know`);
    });

    const reportB = await settleOnce(tillB.queue, { now: () => Date.now(), prepare: relayPrepare(relayer), statuses });
    check(reportB.settled.length === 0, "THE DOUBLE SPEND SETTLED");
    const entryB = (await tillB.queue.all())[0]!;
    ok(`till B reconnects: not paid (${entryB.status}), and the relayer reports the conflict`);

    let frozen = false;
    for (let i = 0; i < 60 && !frozen; i++) {
      const data = await chain.account(vault);
      frozen = data !== null && decodeVault(data).status === 1;
      if (!frozen) await sleep(1000);
    }
    check(frozen, "the vault did not freeze");
    ok("the payer's vault is frozen on chain");
    check((await chain.tokenBalance(associatedTokenAddress(merchantB.address, mint.address, TOKEN_PROGRAM_ID))) === 0n, "merchant B was paid");

    const again = await reportToRelay(relayer, packetA, packetB);
    check(again.done && (again.status === "already-frozen" || again.status === "reported"), `a second report was answered ${JSON.stringify(again)}`);
    ok(`reported again by a till: "${again.done ? again.status : ""}", no second transaction`);

    // -----------------------------------------------------------------------
    section("6. Slashing");

    if (!canStake) {
      note("skipped: nothing is staked on this run (see setup)");
    } else {
      const swept = await relay.sweep();
      check(swept.slashed.length === 1, `the sweep did not slash: ${JSON.stringify(swept.skipped)}`);
      await chain.confirm(swept.slashed[0]!.signature);
      const vaultStake = await chain.tokenBalance(associatedTokenAddress(vault, stakeMint, TOKEN_PROGRAM_ID));
      const reserve = await chain.tokenBalance(associatedTokenAddress(riskConfigAddress(), stakeMint, TOKEN_PROGRAM_ID));
      check(vaultStake === 0n, `the vault still holds ${vaultStake} stake`);
      check(reserve >= staked, `the reserve holds ${reserve}, less than the ${staked} slashed`);
      ok(`the relayer's sweep moved all ${STAKE_UNITS} stake tokens into the reserve`, explorer(swept.slashed[0]!.signature));
    }

    // -----------------------------------------------------------------------
    section("7. After the freeze");

    const { snapshot } = await fetchAll(jsonRpc(chain.url), { mint: mint.address, now: now() });
    await tillA.saveCache(applySnapshot(await tillA.loadCache(), snapshot));
    const payerNow = snapshot.vaults.find((v) => v.address === vault)!.account;
    const payerLookup = lookup(applySnapshot(emptyCache(), snapshot), vault);
    check(payerLookup.found, "the payer's phone could not read its vault after the freeze");
    issuer = applyChain(issuer, chainViewOf(vault, payerNow, payerLookup.risk, now()));
    const refusedByPhone = await pay(issuerStore, secureElement, { merchant: merchantA.address, amount: SALE, now: now() }, (n) => crypto.getRandomValues(new Uint8Array(n)));
    check(!refusedByPhone.ok, "the payer's phone still signs for a frozen vault");
    ok("the payer's phone, once synced, will not sign", refusedByPhone.ok ? "" : refusedByPhone.reason);

    // A voucher signed before the freeze, still in a customer's hand. The
    // program deliberately honours it: a freeze blocks the payer's exit, not
    // the merchants they paid. So the till takes it, and says what it knows.
    const later = { ...signedFields, seq: first.seq + 1n, remainingAfter: first.remainingAfter - SALE, salt: crypto.getRandomValues(new Uint8Array(8)) };
    const laterPacket = encode({ ...later, signature: await secureElement(signedMessage(later)), devicePubkey } as Voucher);
    const atTill = await offline(async () =>
      scan({ text: toQr(laterPacket), cache: await tillA.loadCache(), merchant: merchantA.address, charged: SALE, queued: await tillA.queue.all(), now: now() }),
    );
    check(atTill.kind === "take", `till A refused a good voucher from a frozen vault (${atTill.kind}); the program would pay it`);
    check(atTill.risks.some((r) => r.kind === "vault-frozen"), "till A took it without warning that the vault is frozen");
    ok("a voucher signed before the freeze: till A takes it, and warns the merchant", describeRisk({ kind: "vault-frozen" }));
    const addedLater = enqueue(() => undefined, atTill.packet, Date.now());
    check(addedLater.kind === "added", "till A could not queue it");
    await tillA.add(addedLater.entry, 250_000n, "NGN");
    let laterSig: string | null = null;
    for (let round = 0; round < 60 && !laterSig; round++) {
      const report = await settleOnce(tillA.queue, { now: () => Date.now(), prepare: relayPrepare(relayer), statuses });
      check(report.refused.length === 0 && report.held.length === 0, `refused against the frozen vault: ${JSON.stringify(report.refused.map((e) => e.verdict ?? e.status))}`);
      laterSig = report.settled.find((e) => e.seq === later.seq)?.settledSignature ?? null;
      if (!laterSig) await sleep(1000);
    }
    check(laterSig, "it did not settle within a minute");
    check((await chain.tokenBalance(merchantAToken)) === 2n * SALE, "merchant A was not paid for it");
    ok("and the chain pays it from the locked collateral", explorer(laterSig));

    console.log(`\nGATE REHEARSAL PASSED on ${clusterName}.`);
    console.log("Stood in for: the secure element (a software P-256 key) and the two phones (this process).");
  } finally {
    await relay.app.close();
    // Give back what is left, so devnet SOL is not stranded in throwaway keys.
    for (const k of [owner, relayPayer]) {
      try {
        const left = BigInt(await chain.lamports(k.address));
        if (left > 5_000n) await chain.send([transfer(k.address, funder.address, left - 5_000n)], [k]);
      } catch {
        /* best effort */
      }
    }
  }
}

main().catch((e) => {
  globalThis.fetch = realFetch;
  const message = e instanceof Error ? e.message : String(e);
  console.error(`\n  ✗ ${message}`);
  if (/HTTP 40[13]\b/.test(message)) {
    // The first call is to the RPC, so this is nearly always a bad or expired key.
    console.error(
      `\n  The RPC at ${new URL(rpcUrl!).host} refused the request: its API key is wrong or expired.\n` +
        `  Fix RELAY_RPC_URL in ~/.config/nelo/relay.env (the relayer uses it too), or run on\n` +
        `  devnet's public endpoint for now:\n\n` +
        `    pnpm rehearse --rpc https://api.devnet.solana.com`,
    );
  } else if (!(e instanceof Failed) && e instanceof Error && e.stack) {
    console.error(e.stack.split("\n").slice(1, 6).join("\n"));
  }
  console.error("\nGATE REHEARSAL FAILED.");
  process.exit(1);
});
