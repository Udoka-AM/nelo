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
import { StyleSheet, Text, View } from "react-native";
import { Button, color, Hero, Label, Muted, Notice, radius, Screen, Small, Spinner, TextButton, Title } from "@nelo/ui";
import { CameraView, useCameraPermissions } from "expo-camera";
import { enqueue } from "@nelo/queue";
import { describeRisk, scan, type Scan } from "@nelo/till";
import { formatDollars, formatMoney } from "@nelo/pay";
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
        await addConflict(r.existing.id, r.existing.packet, r.incoming);
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

  const price = formatMoney(props.chargedLocalMinor, props.currency);
  const cancel = <TextButton label="Cancel" onPress={() => props.onDone(false)} />;

  if (!permission) return <Screen center><Spinner /></Screen>;

  if (!permission.granted) {
    return (
      <Screen center>
        <Title center>The camera reads the customer's code</Title>
        <Muted center>Nelo uses it only to scan payment codes, and nothing is recorded.</Muted>
        <Button label="Allow camera" onPress={() => void requestPermission()} />
        {cancel}
      </Screen>
    );
  }

  if (stage.step === "scanning" || stage.step === "checking") {
    return (
      <Screen center>
        <Label center>Scan the customer's payment code</Label>
        <Hero center>{price}</Hero>
        <View style={styles.cameraFrame} accessibilityLabel="Camera">
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={stage.step === "scanning" ? ({ data }) => void onScanned(data) : undefined}
          />
        </View>
        {stage.step === "checking" ? <Spinner label="Checking…" /> : <Muted center>Works with no signal.</Muted>}
        {cancel}
      </Screen>
    );
  }

  if (stage.step === "queued") {
    return (
      <Screen center>
        <Text style={styles.mark} accessibilityLabel="Taken">✓</Text>
        <Title center tone="positive">Payment taken</Title>
        <Hero center>{price}</Hero>
        <Muted center>{formatDollars(stage.amount)} arrives when this phone next has signal and you settle.</Muted>
        <Button label="New sale" onPress={() => props.onDone(true)} />
      </Screen>
    );
  }

  if (stage.step === "problem") {
    return (
      <Screen center>
        <Title center tone="danger">Not taken</Title>
        <Notice tone="danger">{stage.message}</Notice>
        <Button label="Scan again" onPress={again} />
        {cancel}
      </Screen>
    );
  }

  const r = stage.result;
  if (r.kind === "take") {
    return (
      <Screen center>
        <Label center>The customer's payment checks out</Label>
        <Hero center>{price}</Hero>
        <Muted center>
          {formatDollars(r.amount)}
          {r.overpaid ? ", more than you charged" : ""}
        </Muted>
        {r.risks.map((risk) =>
          risk.kind === "sequence-unconfirmed" ? (
            <Small key={risk.kind} center>
              {describeRisk(risk)}
            </Small>
          ) : (
            <Notice key={risk.kind} tone="caution">
              {describeRisk(risk)}
            </Notice>
          ),
        )}
        <Button label="Hand over the goods" onPress={() => void take(r.packet, r.amount)} />
        <Button kind="secondary" label="Don't take it" onPress={again} />
      </Screen>
    );
  }

  const message =
    r.kind === "short"
      ? `This code pays ${formatDollars(r.paid)}, less than the ${formatDollars(r.charged)} charged.`
      : r.kind === "unknown-vault"
        ? "This customer is not on your payer list yet. Sync when you have signal, or take another way to pay."
        : r.kind === "not-synced"
          ? "Your payer list is empty. Connect once to sync it before taking offline payments."
          : r.reason;

  return (
    <Screen center>
      <Title center tone="danger">Not taken</Title>
      <Notice tone="danger">{message}</Notice>
      <Button label="Scan again" onPress={again} />
      {cancel}
    </Screen>
  );
}

const styles = StyleSheet.create({
  mark: { color: color.positive, fontSize: 64, textAlign: "center" },
  cameraFrame: { width: 280, height: 280, borderRadius: radius.lg, overflow: "hidden", backgroundColor: "#000", alignSelf: "center" },
});
