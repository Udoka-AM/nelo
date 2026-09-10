/**
 * Nelo Payer — development build.
 *
 * Right now this app exists to prove the pipeline, not to be the product. It
 * runs the checks that can only be answered on a real handset:
 *
 *   1. Does the shared @nelo/voucher codec work under Hermes? BigInt and
 *      DataView behave differently there than in Node.
 *   2. Does @noble/curves P-256 work under Hermes? The offline path cannot
 *      verify a voucher without it, and it leans hard on BigInt.
 *   3. Does this device have StrongBox? Pending the native module.
 *
 * The real payer UI arrives in week 3. See docs/DELIVERABLES.md.
 */
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { p256 } from "@noble/curves/p256";
import { decode, encode, signedMessage, verify, type Voucher } from "@nelo/voucher";
import * as attest from "@nelo/attest";

type Result = { name: string; ok: boolean; detail: string };

function fill(n: number, byte: number): Uint8Array {
  return new Uint8Array(n).fill(byte);
}

function runChecks(): Result[] {
  const out: Result[] = [];
  const record = (name: string, fn: () => string) => {
    try {
      out.push({ name, ok: true, detail: fn() });
    } catch (e) {
      out.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  };

  // Deterministic key — no getRandomValues needed, so this probes the maths
  // rather than the RNG polyfill.
  const priv = fill(32, 1);
  priv[31] = 7;
  const pub = p256.getPublicKey(priv, true);

  const base = {
    version: 1,
    vault: fill(32, 0x11),
    seq: 42n,
    amount: 12_500_000n,
    remainingAfter: 87_500_000n,
    merchant: fill(32, 0x22),
    expiresAt: 1_789_000_000n,
    salt: fill(8, 0xab),
  };

  record("BigInt + DataView under Hermes", () => {
    const msg = signedMessage(base as Omit<Voucher, "signature" | "devicePubkey">);
    if (msg.length !== 105) throw new Error(`signed message was ${msg.length} bytes`);
    return "105-byte signed message built";
  });

  let voucher: Voucher | undefined;
  record("P-256 sign under Hermes", () => {
    const msg = signedMessage(base as Omit<Voucher, "signature" | "devicePubkey">);
    const sig = p256.sign(msg, priv, { prehash: true, lowS: true });
    voucher = { ...base, signature: sig.toCompactRawBytes(), devicePubkey: pub } as Voucher;
    return "signed, low-S";
  });

  record("202-byte encode/decode round-trip", () => {
    if (!voucher) throw new Error("no voucher");
    const packet = encode(voucher);
    if (packet.length !== 202) throw new Error(`packet was ${packet.length} bytes`);
    const back = decode(packet);
    if (back.amount !== voucher.amount) throw new Error("amount did not survive");
    if (back.seq !== voucher.seq) throw new Error("seq did not survive");
    return "202 bytes, fields intact";
  });

  record("P-256 verify under Hermes", () => {
    if (!voucher) throw new Error("no voucher");
    if (!verify(voucher)) throw new Error("valid voucher failed to verify");
    const tampered = { ...voucher, amount: voucher.amount + 1n };
    if (verify(tampered)) throw new Error("tampered voucher verified — verification is a no-op");
    return "verified, and rejects tampering";
  });

  if (!attest.isAvailable()) {
    out.push({
      name: "StrongBox secure element",
      ok: false,
      detail: "native module not loaded — this needs a development build",
    });
    return out;
  }

  const strongBox = attest.isStrongBoxAvailable();
  out.push({
    name: "StrongBox secure element",
    ok: strongBox,
    detail: strongBox
      ? "present — offline vouchers available"
      : "absent (TEE only) — correct behaviour is online-only on this handset",
  });

  return out;
}

export default function App() {
  const [results, setResults] = useState<Result[] | null>(null);

  useEffect(() => {
    const sync = runChecks();
    setResults(sync);
    if (!attest.isAvailable() || !attest.isStrongBoxAvailable()) return;

    // The end-to-end hardware check: generate a key in the secure element,
    // sign the voucher's 105 bytes with it, and verify that signature with the
    // same code a merchant runs offline. This is the one thing no laptop can
    // answer, and it is where DER encoding and low-S normalisation get tested
    // against real hardware rather than against a library.
    void (async () => {
      const extra: Result[] = [];
      const alias = "nelo-probe";
      try {
        const challenge = new Uint8Array(32).fill(0x5a);
        const key = await attest.generateAttestedKey(alias, challenge);
        extra.push({
          name: "StrongBox keygen + attestation",
          ok: key.publicKey.length === 33 && key.certChain.length > 0,
          detail: `33-byte key, ${key.certChain.length}-cert chain`,
        });

        const probe = {
          version: 1,
          vault: fill(32, 0x11),
          seq: 1n,
          amount: 1_000_000n,
          remainingAfter: 0n,
          merchant: fill(32, 0x22),
          expiresAt: 1_789_000_000n,
          salt: fill(8, 0x01),
        };
        const msg = signedMessage(probe as Omit<Voucher, "signature" | "devicePubkey">);
        const signature = await attest.sign(alias, msg);
        const voucher = { ...probe, signature, devicePubkey: key.publicKey } as Voucher;

        extra.push({
          name: "Hardware signature verifies",
          ok: signature.length === 64 && verify(voucher),
          detail:
            signature.length === 64
              ? "64-byte r||s, low-S, verified against the device key"
              : `expected 64 bytes, got ${signature.length}`,
        });
      } catch (e) {
        extra.push({
          name: "StrongBox round-trip",
          ok: false,
          detail: e instanceof Error ? e.message : String(e),
        });
      } finally {
        await attest.deleteKey(alias).catch(() => {});
      }
      setResults([...sync, ...extra]);
    })();
  }, []);

  const passed = results?.filter((r) => r.ok).length ?? 0;
  const total = results?.length ?? 0;

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.eyebrow}>NELO · PAYER · DEV BUILD</Text>
        <Text style={styles.title}>Device checks</Text>
        <Text style={styles.summary}>
          {results ? `${passed} of ${total} passing` : "running…"}
        </Text>

        {results?.map((r) => (
          <View key={r.name} style={styles.row}>
            <Text style={[styles.mark, r.ok ? styles.ok : styles.pending]}>
              {r.ok ? "✓" : "○"}
            </Text>
            <View style={styles.rowText}>
              <Text style={styles.name}>{r.name}</Text>
              <Text style={styles.detail}>{r.detail}</Text>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#101113" },
  body: { padding: 24, paddingTop: 72 },
  eyebrow: { color: "#8d9299", fontSize: 11, letterSpacing: 2, marginBottom: 10 },
  title: { color: "#e8e9ea", fontSize: 30, fontWeight: "700", letterSpacing: -0.5 },
  summary: { color: "#4fb98f", fontSize: 15, marginTop: 6, marginBottom: 28 },
  row: { flexDirection: "row", gap: 14, paddingVertical: 14, borderTopWidth: 1, borderTopColor: "#282b2f" },
  mark: { fontSize: 17, width: 18 },
  ok: { color: "#4fb98f" },
  pending: { color: "#d4855e" },
  rowText: { flex: 1 },
  name: { color: "#e8e9ea", fontSize: 15.5, fontWeight: "600" },
  detail: { color: "#8d9299", fontSize: 13.5, marginTop: 3, lineHeight: 19 },
});
