/**
 * Nelo Payer — pay a merchant with no signal.
 *
 * Once, online: connect a wallet, make a payment key in this phone's secure
 * element, and lock some USDC in a vault that key is enrolled to.
 *
 * Then, anywhere: scan the merchant's code, confirm, and show the voucher the
 * secure element signs. The merchant's till checks it with no network and
 * settles it when it next has one.
 *
 * Paying another customer is the same two scans. The one being paid shows a
 * receive code, and checks the voucher the way a till does, with the till's
 * own code: see src/receive.ts.
 *
 * Every rule lives in `@nelo/issue`, under test: what can be promised, the
 * sequence counter, and saving before signing. This file is screens.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  Button,
  Card,
  color,
  Field,
  Header,
  Hero,
  Label,
  Muted,
  Notice,
  radius,
  Screen,
  Small,
  space,
  Spinner,
  TextButton,
  Title,
} from "@nelo/ui";
import { StatusBar } from "expo-status-bar";
import { CameraView, useCameraPermissions } from "expo-camera";
import QRCode from "react-native-qrcode-svg";
import * as Crypto from "expo-crypto";
import * as attest from "@nelo/attest";
import { pay, readMerchantCode, resume, spendable, type IssuerState } from "@nelo/issue";
import { formatDollars } from "@nelo/pay";
import { toQr } from "@nelo/voucher";
import { describeRisk, type Scan } from "@nelo/till";
import Probe from "./src/Probe";
import { KEY_ALIAS, USDC_DEVNET } from "./src/config";
import { issuerStore } from "./src/storage";
import { deposit, enrol, loadProfile, sync, type Profile } from "./src/vault";
import { connect } from "./src/wallet";
import { check, keep, requestCode, settleReceived, syncPayers, waiting } from "./src/receive";

type Screen =
  | { name: "loading" }
  | { name: "welcome"; owner: string | null }
  | { name: "home" }
  | { name: "scan" }
  | { name: "confirm"; merchant: string; amount: bigint; label?: string }
  | { name: "voucher"; packet: Uint8Array; amount: bigint }
  | { name: "deposit" }
  | { name: "receive" }
  | { name: "request"; amount: bigint }
  | { name: "receive-scan"; amount: bigint }
  | { name: "receive-check"; amount: bigint; result: Scan }
  | { name: "received"; amount: bigint }
  | { name: "probe" };

const sign = (message: Uint8Array) => attest.sign(KEY_ALIAS, message);
const randomBytes = (n: number) => Crypto.getRandomBytes(n);

/** "12.5" → 12_500_000n. Strict: anything else is null. */
function parseUsdc(text: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) return null;
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}

const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "loading" });
  const [state, setState] = useState<IssuerState | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [amountText, setAmountText] = useState("");
  /** Received from other customers, not yet in the wallet. */
  const [incoming, setIncoming] = useState<{ count: number; amount: bigint }>({ count: 0, amount: 0n });

  const reload = useCallback(async () => {
    const [p, s] = await Promise.all([loadProfile(), issuerStore.load()]);
    setProfile(p);
    setState(s);
    setIncoming(await waiting().catch(() => ({ count: 0, amount: 0n })));
    return { p, s };
  }, []);

  /**
   * Everything that needs signal, in one tap: this vault's state, the payer
   * list for receiving, and settling what was received. Each part fails on
   * its own, so a slow RPC for one does not hide the others.
   */
  async function syncAll() {
    const notes: string[] = [];
    await sync()
      .then(setState)
      .catch((e) => notes.push(e instanceof Error ? e.message : "Could not sync your vault."));
    await syncPayers().catch(() => notes.push("Could not refresh the list of payers."));
    const settled = await settleReceived().catch(() => null);
    if (settled?.kind === "round") {
      const r = settled.report;
      if (r.offline) notes.push("Received payments will settle when the connection is better.");
      if (r.settled.length) notes.push(`${r.settled.length} received ${r.settled.length === 1 ? "payment" : "payments"} arrived in your wallet.`);
      const lost = r.refused.length + r.expired.length;
      if (lost) notes.push(`${lost} received ${lost === 1 ? "payment" : "payments"} will not arrive.`);
      if (settled.conflictsReported) notes.push("A payer who spent the same money twice was reported.");
    } else if (settled?.kind === "no-relay" && incoming.count) {
      notes.push("This build has no relayer set, so received payments wait on the phone.");
    }
    setIncoming(await waiting().catch(() => incoming));
    if (notes.length) setNote(notes.join(" "));
  }

  useEffect(() => {
    void reload()
      .then(({ s }) => setScreen(s ? { name: "home" } : { name: "welcome", owner: null }))
      .catch(() => setScreen({ name: "welcome", owner: null }));
  }, [reload]);

  /** One action at a time: two overlapping saves could lose an update. */
  async function run(label: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setNote(null);
    try {
      await action();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  if (screen.name === "loading") {
    return (
      <Screen center>
        <StatusBar style="light" />
        <Spinner />
      </Screen>
    );
  }

  if (screen.name === "probe") return <Probe onClose={() => setScreen({ name: state ? "home" : "welcome", owner: null } as Screen)} />;

  if (screen.name === "welcome") {
    const deposit0 = parseUsdc(amountText);
    return (
      <Screen center>
        <StatusBar style="light" />
        <Title>Pay without signal</Title>
        <Muted>
          Put some dollars aside on this phone. Its secure chip signs each payment, so a shop can accept it even when
          neither of you has a connection.
        </Muted>
        {!attest.isStrongBoxAvailable() ? (
          <Notice tone="caution">
            This phone has no separate secure chip (StrongBox). Payments are still signed in its protected hardware,
            but it is the weaker kind. Fine for testing.
          </Notice>
        ) : null}
        {screen.owner === null ? (
          <Button
            label={busy ?? "Connect wallet"}
            busy={busy !== null}
            onPress={() =>
              run("Waiting for your wallet…", async () => {
                const owner = await connect();
                if (owner) setScreen({ name: "welcome", owner });
              })
            }
          />
        ) : (
          <>
            <Small>Wallet {short(screen.owner)}</Small>
            <Field
              label="Dollars to set aside (USDC)"
              value={amountText}
              onChangeText={setAmountText}
              keyboardType="decimal-pad"
              placeholder="e.g. 50"
              hint="Your wallet asks you to approve it, and pays a small network fee in SOL."
            />
            <Button
              label={busy ?? "Set it aside"}
              busy={busy !== null}
              disabled={deposit0 === null}
              onPress={() =>
                run("Setting up…", async () => {
                  const r = await enrol(screen.owner!, deposit0!);
                  if (!r.ok) {
                    setNote(r.reason);
                    return;
                  }
                  setAmountText("");
                  await reload();
                  setScreen({ name: "home" });
                })
              }
            />
          </>
        )}
        {note ? <Notice tone="danger">{note}</Notice> : null}
        <TextButton label="Device check" onPress={() => setScreen({ name: "probe" })} />
      </Screen>
    );
  }

  if (!state) return null;

  if (screen.name === "receive") {
    const amount = parseUsdc(amountText);
    return (
      <Screen>
        <StatusBar style="light" />
        <Header title="Receive" actions={[{ label: "Cancel", onPress: () => setScreen({ name: "home" }) }]} />
        <Muted>From another Nelo user, with no signal on either phone.</Muted>
        <Field
          label="How much, in dollars"
          value={amountText}
          onChangeText={setAmountText}
          keyboardType="decimal-pad"
          placeholder="e.g. 7.50"
        />
        <Button
          label={amount ? `Ask for ${formatDollars(amount)}` : "Show my code"}
          disabled={amount === null || amount === 0n}
          onPress={() => {
            setAmountText("");
            setScreen({ name: "request", amount: amount! });
          }}
        />
      </Screen>
    );
  }

  if (screen.name === "request" && profile) {
    return (
      <Screen center>
        <StatusBar style="light" />
        <Label center>Ask them to scan this with Nelo</Label>
        <Hero center>{formatDollars(screen.amount)}</Hero>
        <View style={styles.qrFrame}>
          <QRCode value={requestCode(profile.owner, screen.amount)} size={240} backgroundColor={color.qrBackground} color={color.qrForeground} />
        </View>
        <Muted center>Then scan the code their phone shows you.</Muted>
        <Button label="Scan their payment" onPress={() => setScreen({ name: "receive-scan", amount: screen.amount })} />
        <TextButton label="Cancel" onPress={() => setScreen({ name: "home" })} />
      </Screen>
    );
  }

  if (screen.name === "receive-scan" && profile) {
    return (
      <MerchantScanner
        label="Scan the payment code on their phone"
        onCancel={() => setScreen({ name: "request", amount: screen.amount })}
        onScanned={(text) => {
          void check(text, profile.owner, screen.amount)
            .then((result) => setScreen({ name: "receive-check", amount: screen.amount, result }))
            .catch((e) => {
              setNote(e instanceof Error ? e.message : "Could not check that code.");
              setScreen({ name: "home" });
            });
        }}
      />
    );
  }

  if (screen.name === "receive-check") {
    const r = screen.result;
    const why =
      r.kind === "take"
        ? null
        : r.kind === "short"
          ? `It pays ${formatDollars(r.paid)}, less than the ${formatDollars(r.charged)} you asked for.`
          : r.kind === "unknown-vault"
            ? "This payer is not on your list yet. Sync when you have signal, then try again."
            : r.kind === "not-synced"
              ? "Sync once with signal before receiving offline: your phone needs the list of payers to check against."
              : r.reason;
    return (
      <Screen center>
        <StatusBar style="light" />
        {r.kind === "take" ? (
          <>
            <Label center>Their payment checks out</Label>
            <Hero center>{formatDollars(r.amount)}</Hero>
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
            <Button
              label={busy ?? "Accept"}
              busy={busy !== null}
              onPress={() =>
                run("Saving…", async () => {
                  const kept = await keep(r.packet);
                  if (kept.kind === "conflict") {
                    setNote("Their phone signed two different payments with the same number. Do not accept it.");
                    setScreen({ name: "home" });
                    return;
                  }
                  setIncoming(await waiting());
                  setScreen({ name: "received", amount: r.amount });
                })
              }
            />
          </>
        ) : (
          <>
            <Title center tone="danger">
              Not accepted
            </Title>
            <Notice tone="danger">{why}</Notice>
            <Button label="Scan again" onPress={() => setScreen({ name: "receive-scan", amount: screen.amount })} />
          </>
        )}
        <TextButton label="Cancel" onPress={() => setScreen({ name: "home" })} />
      </Screen>
    );
  }

  if (screen.name === "received") {
    return (
      <Screen center>
        <StatusBar style="light" />
        <Text style={styles.mark}>✓</Text>
        <Title center tone="positive">
          Received
        </Title>
        <Hero center>{formatDollars(screen.amount)}</Hero>
        <Muted center>It arrives in your wallet when this phone next syncs with signal.</Muted>
        <Button label="Done" onPress={() => setScreen({ name: "home" })} />
      </Screen>
    );
  }

  if (screen.name === "scan") {
    return (
      <MerchantScanner
        label="Scan the code you are paying"
        onCancel={() => setScreen({ name: "home" })}
        onScanned={(text) => {
          const r = readMerchantCode(text, USDC_DEVNET);
          if (!r.ok) {
            setNote(r.reason);
            setScreen({ name: "home" });
            return;
          }
          setScreen({ name: "confirm", merchant: r.merchant, amount: r.amount, ...(r.label ? { label: r.label } : {}) });
        }}
      />
    );
  }

  if (screen.name === "confirm") {
    return (
      <Screen center>
        <StatusBar style="light" />
        <Label center>
          Pay {screen.label ?? "this shop"} · {short(screen.merchant)}
        </Label>
        <Hero center>{formatDollars(screen.amount)}</Hero>
        <Muted center>You have {formatDollars(spendable(state))} available offline.</Muted>
        <Button
          label={busy ?? `Pay ${formatDollars(screen.amount)}`}
          busy={busy !== null}
          onPress={() =>
            run("Signing…", async () => {
              const r = await pay(
                issuerStore,
                sign,
                { merchant: screen.merchant, amount: screen.amount, now: Math.floor(Date.now() / 1000) },
                randomBytes,
              );
              await reload();
              if (!r.ok) {
                setNote(r.reason);
                setScreen({ name: "home" });
                return;
              }
              setScreen({ name: "voucher", packet: r.packet, amount: screen.amount });
            })
          }
        />
        <TextButton label="Cancel" onPress={() => setScreen({ name: "home" })} />
      </Screen>
    );
  }

  if (screen.name === "voucher") {
    return (
      <Screen center>
        <StatusBar style="light" />
        <Label center>Show this to whoever you are paying</Label>
        <Hero center>{formatDollars(screen.amount)}</Hero>
        <View style={styles.qrFrame} accessible accessibilityLabel={`Payment code for ${formatDollars(screen.amount)}`}>
          <QRCode value={toQr(screen.packet)} size={280} ecl="M" backgroundColor={color.qrBackground} color={color.qrForeground} />
        </View>
        <Muted center>No signal needed. They are paid when their phone next connects.</Muted>
        <Button label="Done" onPress={() => setScreen({ name: "home" })} />
      </Screen>
    );
  }

  if (screen.name === "deposit") {
    const amount = parseUsdc(amountText);
    return (
      <Screen>
        <StatusBar style="light" />
        <Header title="Add money" actions={[{ label: "Cancel", onPress: () => setScreen({ name: "home" }) }]} />
        <Field
          label="Dollars to set aside (USDC)"
          value={amountText}
          onChangeText={setAmountText}
          keyboardType="decimal-pad"
          placeholder="e.g. 20"
          hint="From your wallet, which asks you to approve it."
        />
        <Button
          label={busy ?? (amount ? `Set aside ${formatDollars(amount)}` : "Set it aside")}
          busy={busy !== null}
          disabled={amount === null || amount === 0n}
          onPress={() =>
            run("Waiting for your wallet…", async () => {
              await deposit(profile!.owner, amount!);
              setAmountText("");
              setNote("Sent. Sync in a moment to see it.");
              setScreen({ name: "home" });
            })
          }
        />
      </Screen>
    );
  }

  // Home.
  const interrupted = state.pending !== null;
  return (
    <Screen>
      <StatusBar style="light" />
      <Card>
        <Label>Available offline</Label>
        <Hero>{formatDollars(spendable(state))}</Hero>
        <Small>
          {formatDollars(state.chain.balance)} set aside · up to {formatDollars(state.chain.limit)} per payment
        </Small>
      </Card>
      {state.chain.status === 1 ? (
        <Notice tone="danger">This vault is frozen after a conflicting payment. It cannot pay offline.</Notice>
      ) : null}
      {state.outstanding.length ? (
        <Notice tone="caution">
          {state.outstanding.length} {state.outstanding.length === 1 ? "payment" : "payments"} waiting to settle
        </Notice>
      ) : null}
      {incoming.count ? (
        <Notice tone="positive">{formatDollars(incoming.amount)} received, arriving in your wallet when you sync</Notice>
      ) : null}

      {interrupted ? (
        <Button
          label={busy ?? "Finish the interrupted payment"}
          busy={busy !== null}
          onPress={() =>
            run("Signing…", async () => {
              const r = await resume(issuerStore, sign);
              await reload();
              if (!r.ok) {
                setNote(r.reason);
                return;
              }
              setScreen({ name: "voucher", packet: r.packet, amount: state.pending!.amount });
            })
          }
        />
      ) : (
        <Button label="Pay" onPress={() => setScreen({ name: "scan" })} />
      )}
      <Button kind="secondary" label="Receive from someone" onPress={() => setScreen({ name: "receive" })} />
      <View style={styles.row}>
        <Button
          kind="secondary"
          style={styles.rowButton}
          label={busy === "Syncing…" ? busy : "Sync"}
          busy={busy === "Syncing…"}
          onPress={() => run("Syncing…", syncAll)}
        />
        <Button kind="secondary" style={styles.rowButton} label="Add money" onPress={() => setScreen({ name: "deposit" })} />
      </View>
      {note ? <Notice tone="caution">{note}</Notice> : null}
      <Small center>Synced {ago(state.chain.syncedAt)}</Small>
      {profile && !profile.strongBoxBacked ? (
        <Small center>Key held in protected hardware, not a separate secure chip.</Small>
      ) : null}
      <TextButton label="Device check" onPress={() => setScreen({ name: "probe" })} />
    </Screen>
  );
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
function ago(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (s < 60) return "just now";
  const [n, unit] = s < 3600 ? [Math.floor(s / 60), "minute"] : s < 86_400 ? [Math.floor(s / 3600), "hour"] : [Math.floor(s / 86_400), "day"];
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

function MerchantScanner({
  label,
  onScanned,
  onCancel,
}: {
  label: string;
  onScanned: (text: string) => void;
  onCancel: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const locked = useRef(false);
  if (!permission) return <Screen center><Spinner /></Screen>;
  return (
    <Screen center>
      <StatusBar style="light" />
      <Label center>{label}</Label>
      {permission.granted ? (
        <View style={styles.cameraFrame} accessibilityLabel="Camera">
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={({ data }) => {
              if (locked.current) return;
              locked.current = true;
              onScanned(data);
            }}
          />
        </View>
      ) : (
        <>
          <Muted center>Nelo uses the camera only to read payment codes.</Muted>
          <Button label="Allow camera" onPress={() => void requestPermission()} />
        </>
      )}
      <TextButton label="Cancel" onPress={onCancel} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  mark: { color: color.positive, fontSize: 64, textAlign: "center" },
  qrFrame: { backgroundColor: color.qrBackground, padding: space.lg, borderRadius: radius.lg, alignSelf: "center" },
  cameraFrame: { width: 280, height: 280, borderRadius: radius.lg, overflow: "hidden", backgroundColor: "#000", alignSelf: "center" },
  row: { flexDirection: "row", gap: space.sm },
  rowButton: { flex: 1, alignSelf: "auto" },
});
