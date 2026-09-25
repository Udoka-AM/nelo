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
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { CameraView, useCameraPermissions } from "expo-camera";
import QRCode from "react-native-qrcode-svg";
import * as Crypto from "expo-crypto";
import * as attest from "@nelo/attest";
import { pay, readMerchantCode, resume, spendable, type IssuerState } from "@nelo/issue";
import { formatTokenAmount } from "@nelo/pay";
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
      <View style={[styles.screen, styles.centre]}>
        <StatusBar style="light" />
        <ActivityIndicator color="#4fb98f" />
      </View>
    );
  }

  if (screen.name === "probe") return <Probe onClose={() => setScreen({ name: state ? "home" : "welcome", owner: null } as Screen)} />;

  if (screen.name === "welcome") {
    const deposit0 = parseUsdc(amountText);
    return (
      <View style={styles.screen}>
        <StatusBar style="light" />
        <View style={styles.body}>
          <Text style={styles.title}>Pay without signal</Text>
          <Text style={styles.text}>
            Lock some USDC in your offline wallet. This phone's secure chip signs each payment, so
            merchants can accept it even when neither of you has a connection.
          </Text>
          {!attest.isStrongBoxAvailable() ? (
            <Text style={styles.warn}>
              This phone has no separate secure chip (StrongBox). Payments will still be signed in its
              protected hardware, but it is the weaker kind. Fine for testing.
            </Text>
          ) : null}
          {screen.owner === null ? (
            <Pressable
              style={styles.primary}
              onPress={() =>
                run("Waiting for your wallet…", async () => {
                  const owner = await connect();
                  if (owner) setScreen({ name: "welcome", owner });
                })
              }
            >
              <Text style={styles.primaryText}>{busy ?? "Connect wallet"}</Text>
            </Pressable>
          ) : (
            <>
              <Text style={styles.label}>Wallet {short(screen.owner)}</Text>
              <Text style={styles.label}>USDC to lock for offline payments</Text>
              <TextInput
                style={styles.input}
                value={amountText}
                onChangeText={setAmountText}
                keyboardType="decimal-pad"
                placeholder="e.g. 50"
                placeholderTextColor="#5f646b"
              />
              <Pressable
                style={[styles.primary, (deposit0 === null || busy !== null) && styles.disabled]}
                disabled={deposit0 === null || busy !== null}
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
              >
                <Text style={styles.primaryText}>{busy ?? "Open my offline wallet"}</Text>
              </Pressable>
            </>
          )}
          {note ? <Text style={styles.warn}>{note}</Text> : null}
          <Pressable style={styles.secondary} onPress={() => setScreen({ name: "probe" })}>
            <Text style={styles.secondaryText}>Device check</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (!state) return null;

  if (screen.name === "receive") {
    const amount = parseUsdc(amountText);
    return (
      <View style={styles.screen}>
        <StatusBar style="light" />
        <View style={styles.body}>
          <Text style={styles.title}>Receive</Text>
          <Text style={styles.text}>From another Nelo user, with no signal on either phone.</Text>
          <Text style={styles.label}>USDC to ask for</Text>
          <TextInput
            style={styles.input}
            value={amountText}
            onChangeText={setAmountText}
            keyboardType="decimal-pad"
            placeholder="e.g. 7.50"
            placeholderTextColor="#5f646b"
          />
          <Pressable
            style={[styles.primary, (amount === null || amount === 0n) && styles.disabled]}
            disabled={amount === null || amount === 0n}
            onPress={() => {
              setAmountText("");
              setScreen({ name: "request", amount: amount! });
            }}
          >
            <Text style={styles.primaryText}>Show my code</Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={() => setScreen({ name: "home" })}>
            <Text style={styles.secondaryText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (screen.name === "request" && profile) {
    return (
      <View style={styles.screen}>
        <StatusBar style="light" />
        <View style={styles.body}>
          <Text style={styles.label}>Ask them to scan this with Nelo</Text>
          <Text style={styles.big}>{formatTokenAmount(screen.amount)} USDC</Text>
          <View style={styles.qrFrame}>
            <QRCode value={requestCode(profile.owner, screen.amount)} size={260} backgroundColor="#ffffff" color="#101113" />
          </View>
          <Text style={styles.text}>Then scan the code their phone shows you.</Text>
          <Pressable style={styles.primary} onPress={() => setScreen({ name: "receive-scan", amount: screen.amount })}>
            <Text style={styles.primaryText}>Scan their payment</Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={() => setScreen({ name: "home" })}>
            <Text style={styles.secondaryText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
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
          ? `It pays ${formatTokenAmount(r.paid)} USDC, less than the ${formatTokenAmount(r.charged)} you asked for.`
          : r.kind === "unknown-vault"
            ? "This payer is not on your list yet. Sync when you have signal, then try again."
            : r.kind === "not-synced"
              ? "Sync once with signal before receiving offline: your phone needs the list of payers to check against."
              : r.reason;
    return (
      <View style={styles.screen}>
        <StatusBar style="light" />
        <View style={styles.body}>
          {r.kind === "take" ? (
            <>
              <Text style={styles.label}>Their payment checks out</Text>
              <Text style={styles.big}>{formatTokenAmount(r.amount)} USDC</Text>
              {r.risks.map((risk) => (
                <Text key={risk.kind} style={risk.kind === "sequence-unconfirmed" ? styles.textSmall : styles.warn}>
                  {describeRisk(risk)}
                </Text>
              ))}
              <Pressable
                style={[styles.primary, busy !== null && styles.disabled]}
                disabled={busy !== null}
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
              >
                <Text style={styles.primaryText}>{busy ?? "Accept"}</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.title}>Not accepted</Text>
              <Text style={styles.text}>{why}</Text>
              <Pressable style={styles.primary} onPress={() => setScreen({ name: "receive-scan", amount: screen.amount })}>
                <Text style={styles.primaryText}>Scan again</Text>
              </Pressable>
            </>
          )}
          <Pressable style={styles.secondary} onPress={() => setScreen({ name: "home" })}>
            <Text style={styles.secondaryText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (screen.name === "received") {
    return (
      <View style={styles.screen}>
        <StatusBar style="light" />
        <View style={styles.body}>
          <Text style={styles.good}>✓</Text>
          <Text style={styles.title}>Received</Text>
          <Text style={styles.big}>{formatTokenAmount(screen.amount)} USDC</Text>
          <Text style={styles.text}>It arrives in your wallet when this phone next syncs with signal.</Text>
          <Pressable style={styles.primary} onPress={() => setScreen({ name: "home" })}>
            <Text style={styles.primaryText}>Done</Text>
          </Pressable>
        </View>
      </View>
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
      <View style={styles.screen}>
        <StatusBar style="light" />
        <View style={styles.body}>
          <Text style={styles.label}>Pay {screen.label ?? "merchant"} {short(screen.merchant)}</Text>
          <Text style={styles.big}>{formatTokenAmount(screen.amount)} USDC</Text>
          <Text style={styles.text}>You have {formatTokenAmount(spendable(state))} USDC available offline.</Text>
          <Pressable
            style={[styles.primary, busy !== null && styles.disabled]}
            disabled={busy !== null}
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
          >
            <Text style={styles.primaryText}>{busy ?? "Pay"}</Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={() => setScreen({ name: "home" })}>
            <Text style={styles.secondaryText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (screen.name === "voucher") {
    return (
      <View style={styles.screen}>
        <StatusBar style="light" />
        <View style={styles.body}>
          <Text style={styles.label}>Show this to whoever you are paying</Text>
          <Text style={styles.big}>{formatTokenAmount(screen.amount)} USDC</Text>
          <View style={styles.qrFrame}>
            <QRCode value={toQr(screen.packet)} size={300} ecl="M" backgroundColor="#ffffff" color="#101113" />
          </View>
          <Text style={styles.text}>No signal needed. They are paid when their phone next connects.</Text>
          <Pressable style={styles.primary} onPress={() => setScreen({ name: "home" })}>
            <Text style={styles.primaryText}>Done</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (screen.name === "deposit") {
    const amount = parseUsdc(amountText);
    return (
      <View style={styles.screen}>
        <StatusBar style="light" />
        <View style={styles.body}>
          <Text style={styles.title}>Add money</Text>
          <Text style={styles.label}>USDC to lock</Text>
          <TextInput
            style={styles.input}
            value={amountText}
            onChangeText={setAmountText}
            keyboardType="decimal-pad"
            placeholder="e.g. 20"
            placeholderTextColor="#5f646b"
          />
          <Pressable
            style={[styles.primary, (amount === null || amount === 0n || busy !== null) && styles.disabled]}
            disabled={amount === null || amount === 0n || busy !== null}
            onPress={() =>
              run("Waiting for your wallet…", async () => {
                await deposit(profile!.owner, amount!);
                setAmountText("");
                setNote("Sent. Sync in a moment to see it.");
                setScreen({ name: "home" });
              })
            }
          >
            <Text style={styles.primaryText}>{busy ?? "Lock it"}</Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={() => setScreen({ name: "home" })}>
            <Text style={styles.secondaryText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // Home.
  const interrupted = state.pending !== null;
  const synced = new Date(state.chain.syncedAt * 1000);
  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.label}>AVAILABLE OFFLINE</Text>
        <Text style={styles.big}>{formatTokenAmount(spendable(state))} USDC</Text>
        <Text style={styles.text}>
          Locked {formatTokenAmount(state.chain.balance)} · up to {formatTokenAmount(state.chain.limit)} per payment
        </Text>
        <Text style={styles.textSmall}>
          {state.outstanding.length} {state.outstanding.length === 1 ? "payment" : "payments"} waiting to settle ·
          synced {synced.toLocaleString()}
        </Text>
        {incoming.count ? (
          <Text style={styles.textSmall}>
            {formatTokenAmount(incoming.amount)} USDC received, arriving in your wallet when you sync
          </Text>
        ) : null}
        {state.chain.status === 1 ? (
          <Text style={styles.warn}>This vault is frozen after a conflicting payment. It cannot pay offline.</Text>
        ) : null}

        {interrupted ? (
          <Pressable
            style={styles.primary}
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
          >
            <Text style={styles.primaryText}>{busy ?? "Finish the interrupted payment"}</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.primary} onPress={() => setScreen({ name: "scan" })}>
            <Text style={styles.primaryText}>Pay</Text>
          </Pressable>
        )}
        <Pressable style={styles.secondaryWide} onPress={() => setScreen({ name: "receive" })}>
          <Text style={styles.secondaryText}>Receive from someone</Text>
        </Pressable>

        <View style={styles.row}>
          <Pressable
            style={styles.rowButton}
            onPress={() =>
              run("Syncing…", syncAll)
            }
          >
            <Text style={styles.secondaryText}>{busy === "Syncing…" ? busy : "Sync"}</Text>
          </Pressable>
          <Pressable style={styles.rowButton} onPress={() => setScreen({ name: "deposit" })}>
            <Text style={styles.secondaryText}>Add money</Text>
          </Pressable>
          <Pressable style={styles.rowButton} onPress={() => setScreen({ name: "probe" })}>
            <Text style={styles.secondaryText}>Device check</Text>
          </Pressable>
        </View>
        {note ? <Text style={styles.warn}>{note}</Text> : null}
        {profile && !profile.strongBoxBacked ? (
          <Text style={styles.textSmall}>Key held in protected hardware, not a separate secure chip.</Text>
        ) : null}
      </ScrollView>
    </View>
  );
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
  if (!permission) return <View style={styles.screen} />;
  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.body}>
        <Text style={styles.label}>{label}</Text>
        {permission.granted ? (
          <View style={styles.cameraFrame}>
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
          <Pressable style={styles.primary} onPress={requestPermission}>
            <Text style={styles.primaryText}>Allow camera</Text>
          </Pressable>
        )}
        <Pressable style={styles.secondary} onPress={onCancel}>
          <Text style={styles.secondaryText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#101113", paddingTop: 64, paddingHorizontal: 20 },
  centre: { alignItems: "center", justifyContent: "center" },
  body: { flexGrow: 1, justifyContent: "center", alignItems: "center", gap: 16, paddingBottom: 40 },
  title: { color: "#e8e9ea", fontSize: 28, fontWeight: "700", textAlign: "center" },
  big: { color: "#e8e9ea", fontSize: 38, fontWeight: "700", letterSpacing: -1 },
  label: { color: "#8d9299", fontSize: 13, letterSpacing: 1, textAlign: "center" },
  text: { color: "#8d9299", fontSize: 15.5, lineHeight: 23, textAlign: "center" },
  textSmall: { color: "#5f646b", fontSize: 13, textAlign: "center" },
  warn: { color: "#d4855e", fontSize: 14.5, lineHeight: 21, textAlign: "center" },
  input: {
    alignSelf: "stretch",
    color: "#e8e9ea",
    fontSize: 22,
    borderWidth: 1,
    borderColor: "#282b2f",
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    textAlign: "center",
  },
  primary: {
    backgroundColor: "#1a6b4c",
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: "center",
    alignSelf: "stretch",
    marginTop: 8,
  },
  disabled: { backgroundColor: "#1d1f22" },
  primaryText: { color: "#ffffff", fontSize: 17, fontWeight: "700" },
  secondary: { paddingVertical: 14, paddingHorizontal: 40 },
  secondaryText: { color: "#8d9299", fontSize: 15.5 },
  secondaryWide: {
    alignSelf: "stretch",
    alignItems: "center",
    paddingVertical: 16,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#282b2f",
  },
  good: { color: "#4fb98f", fontSize: 64 },
  row: { flexDirection: "row", gap: 8, alignSelf: "stretch", justifyContent: "space-between" },
  rowButton: { flex: 1, alignItems: "center", paddingVertical: 12, borderRadius: 12, backgroundColor: "#17191b" },
  qrFrame: { backgroundColor: "#ffffff", padding: 16, borderRadius: 16 },
  cameraFrame: { width: 280, height: 280, borderRadius: 18, overflow: "hidden", backgroundColor: "#000" },
});
