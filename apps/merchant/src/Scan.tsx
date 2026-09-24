/**
 * Taking an offline payment: scan the customer's code, decide, hand over.
 *
 * Everything that decides lives in `@nelo/till`, under test. This screen only
 * points the camera, shows the answer, and — on the merchant's say-so — puts
 * the voucher in the queue. Nothing here needs a network: that is the point of
 * it.
 *
 * The merchant confirms before the voucher is queued, even when every check
 * passes. The risks are theirs to weigh, and a till that takes the money on a
 * glance at a code decides for them.
 */
import { useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { enqueue } from "@nelo/queue";
import { describeRisk, scan, type Scan } from "@nelo/till";
import { formatLocalAmount, formatTokenAmount } from "@nelo/pay";
import { getBase64Decoder } from "@solana/kit";
import { addConflict, addVoucher, loadCache, voucherStore } from "./offline";

export interface ScanProps {
  /** This till's address, base58. */
  merchant: string;
  /** What was charged, in token base units and in the merchant's currency. */
  chargedBaseUnits: bigint;
  chargedLocalMinor: bigint;
  currency: { code: string; symbol: string; minorDigits: number };
  /** `true` once a voucher is safely queued. */
  onDone: (took: boolean) => void;
}

type Stage =
  | { step: "scanning" }
  | { step: "checking" }
  | { step: "decided"; result: Scan }
  | { step: "queued"; amount: bigint }
  | { step: "problem"; message: string };

export default function ScanPayment(props: ScanProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [stage, setStage] = useState<Stage>({ step: "scanning" });
  // The camera fires many times a second on one code. Only the first counts.
  const locked = useRef(false);

  const onScanned = useCallback(
    async (text: string) => {
      if (locked.current) return;
      locked.current = true;
      setStage({ step: "checking" });
      try {
        const result = scan({
          text,
          cache: await loadCache(),
          merchant: props.merchant,
          charged: props.chargedBaseUnits,
          queued: await voucherStore.all(),
          now: Math.floor(Date.now() / 1000),
        });
        setStage({ step: "decided", result });
      } catch (e) {
        setStage({ step: "problem", message: e instanceof Error ? e.message : "Something went wrong." });
      }
    },
    [props.merchant, props.chargedBaseUnits],
  );

  function again() {
    locked.current = false;
    setStage({ step: "scanning" });
  }

  async function take(packet: Uint8Array, amount: bigint) {
    try {
      const queued = await voucherStore.all();
      const r = enqueue((id) => queued.find((e) => e.id === id), packet, Date.now());
      if (r.kind === "conflict") {
        // Two different payments signed at one sequence: the payer's phone
        // has spent the same money twice. Do not hand anything over. Keep the
        // pair: on the next settle the relayer reports it, which freezes the
        // payer's vault and takes their stake.
        const b64 = getBase64Decoder();
        await addConflict(r.existing.id, b64.decode(r.existing.packet), b64.decode(r.incoming));
        setStage({
          step: "problem",
          message:
            "This customer's phone has signed two different payments with the same number. Do not hand over the goods.",
        });
        return;
      }
      if (r.kind === "added") await addVoucher(r.entry, props.chargedLocalMinor, props.currency.code);
      setStage({ step: "queued", amount });
    } catch (e) {
      setStage({ step: "problem", message: e instanceof Error ? e.message : "Could not save the payment." });
    }
  }

  const price = `${props.currency.symbol}${formatLocalAmount(props.chargedLocalMinor, props.currency.minorDigits)}`;

  if (!permission) return <View style={styles.body} />;

  if (!permission.granted) {
    return (
      <View style={styles.body}>
        <Text style={styles.title}>The camera reads the customer's code</Text>
        <Text style={styles.text}>Nelo uses it only to scan payment codes, and nothing is recorded.</Text>
        <Pressable style={styles.primary} onPress={requestPermission} accessibilityRole="button">
          <Text style={styles.primaryText}>Allow camera</Text>
        </Pressable>
        <Pressable style={styles.secondary} onPress={() => props.onDone(false)} accessibilityRole="button">
          <Text style={styles.secondaryText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  if (stage.step === "scanning" || stage.step === "checking") {
    return (
      <View style={styles.body}>
        <Text style={styles.label}>Scan the customer's payment code</Text>
        <Text style={styles.price}>{price}</Text>
        <View style={styles.cameraFrame}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={stage.step === "scanning" ? ({ data }) => void onScanned(data) : undefined}
          />
        </View>
        <Text style={styles.text}>{stage.step === "checking" ? "Checking…" : "Works with no signal."}</Text>
        <Pressable style={styles.secondary} onPress={() => props.onDone(false)} accessibilityRole="button">
          <Text style={styles.secondaryText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  if (stage.step === "queued") {
    return (
      <View style={styles.body}>
        <Text style={styles.good}>✓</Text>
        <Text style={styles.title}>Payment taken</Text>
        <Text style={styles.price}>{price}</Text>
        <Text style={styles.text}>
          {formatTokenAmount(stage.amount)} USDC arrives when this phone next has signal and you settle.
        </Text>
        <Pressable style={styles.primary} onPress={() => props.onDone(true)} accessibilityRole="button">
          <Text style={styles.primaryText}>New sale</Text>
        </Pressable>
      </View>
    );
  }

  if (stage.step === "problem") {
    return (
      <View style={styles.body}>
        <Text style={styles.title}>Not taken</Text>
        <Text style={styles.text}>{stage.message}</Text>
        <Pressable style={styles.primary} onPress={again} accessibilityRole="button">
          <Text style={styles.primaryText}>Scan again</Text>
        </Pressable>
        <Pressable style={styles.secondary} onPress={() => props.onDone(false)} accessibilityRole="button">
          <Text style={styles.secondaryText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  const r = stage.result;
  if (r.kind === "take") {
    return (
      <View style={styles.body}>
        <Text style={styles.label}>Customer's payment checks out</Text>
        <Text style={styles.price}>{price}</Text>
        <Text style={styles.text}>
          {formatTokenAmount(r.amount)} USDC{r.overpaid ? " — more than you charged" : ""}
        </Text>
        <View style={styles.risks}>
          {r.risks.map((risk) => (
            <Text key={risk.kind} style={risk.kind === "sequence-unconfirmed" ? styles.riskQuiet : styles.risk}>
              {describeRisk(risk)}
            </Text>
          ))}
        </View>
        <Pressable style={styles.primary} onPress={() => void take(r.packet, r.amount)} accessibilityRole="button">
          <Text style={styles.primaryText}>Hand over the goods</Text>
        </Pressable>
        <Pressable style={styles.secondary} onPress={again} accessibilityRole="button">
          <Text style={styles.secondaryText}>Don't take it</Text>
        </Pressable>
      </View>
    );
  }

  const message =
    r.kind === "short"
      ? `This code pays ${formatTokenAmount(r.paid)} USDC, less than the ${formatTokenAmount(r.charged)} charged.`
      : r.kind === "unknown-vault"
        ? "This customer is not on your payer list yet. Sync when you have signal, or take another way to pay."
        : r.kind === "not-synced"
          ? "Your payer list is empty. Connect once to sync it before taking offline payments."
          : r.reason;

  return (
    <View style={styles.body}>
      <Text style={styles.title}>Not taken</Text>
      <Text style={styles.text}>{message}</Text>
      <Pressable style={styles.primary} onPress={again} accessibilityRole="button">
        <Text style={styles.primaryText}>Scan again</Text>
      </Pressable>
      <Pressable style={styles.secondary} onPress={() => props.onDone(false)} accessibilityRole="button">
        <Text style={styles.secondaryText}>Cancel</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
  label: { color: "#8d9299", fontSize: 13, letterSpacing: 1 },
  title: { color: "#e8e9ea", fontSize: 24, fontWeight: "700", textAlign: "center" },
  price: { color: "#e8e9ea", fontSize: 36, fontWeight: "700", letterSpacing: -1 },
  text: { color: "#8d9299", fontSize: 15.5, lineHeight: 23, textAlign: "center", paddingHorizontal: 8 },
  good: { color: "#4fb98f", fontSize: 64 },
  cameraFrame: { width: 280, height: 280, borderRadius: 18, overflow: "hidden", backgroundColor: "#000" },
  risks: { gap: 8, alignSelf: "stretch" },
  risk: { color: "#d4855e", fontSize: 14.5, lineHeight: 21, textAlign: "center" },
  riskQuiet: { color: "#8d9299", fontSize: 14, lineHeight: 21, textAlign: "center" },
  primary: {
    backgroundColor: "#1a6b4c",
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: "center",
    alignSelf: "stretch",
    marginTop: 8,
  },
  primaryText: { color: "#ffffff", fontSize: 17, fontWeight: "700" },
  secondary: { paddingVertical: 14, paddingHorizontal: 40 },
  secondaryText: { color: "#8d9299", fontSize: 16 },
});
