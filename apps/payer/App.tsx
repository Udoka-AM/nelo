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
import Probe from "./src/Probe";
import { KEY_ALIAS, USDC_DEVNET } from "./src/config";
import { issuerStore } from "./src/storage";
import { deposit, enrol, loadProfile, sync, type Profile } from "./src/vault";
import { connect } from "./src/wallet";

type Screen =
  | { name: "loading" }
  | { name: "welcome"; owner: string | null }
  | { name: "home" }
  | { name: "scan" }
  | { name: "confirm"; merchant: string; amount: bigint; label?: string }
  | { name: "voucher"; packet: Uint8Array; amount: bigint }
  | { name: "deposit" }
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

  const reload = useCallback(async () => {
    const [p, s] = await Promise.all([loadProfile(), issuerStore.load()]);
    setProfile(p);
    setState(s);
    return { p, s };
  }, []);

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

  if (screen.name === "scan") {
    return (
      <MerchantScanner
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
          <Text style={styles.label}>Show this to the merchant</Text>
          <Text style={styles.big}>{formatTokenAmount(screen.amount)} USDC</Text>
          <View style={styles.qrFrame}>
            <QRCode value={toQr(screen.packet)} size={300} ecl="M" backgroundColor="#ffffff" color="#101113" />
          </View>
          <Text style={styles.text}>No signal needed. The merchant is paid when their till next connects.</Text>
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
            <Text style={styles.primaryText}>Pay a merchant</Text>
          </Pressable>
        )}

        <View style={styles.row}>
          <Pressable
            style={styles.rowButton}
            onPress={() =>
              run("Syncing…", async () => {
                setState(await sync());
              })
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

function MerchantScanner({ onScanned, onCancel }: { onScanned: (text: string) => void; onCancel: () => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const locked = useRef(false);
  if (!permission) return <View style={styles.screen} />;
  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.body}>
        <Text style={styles.label}>Scan the merchant's payment code</Text>
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
  row: { flexDirection: "row", gap: 8, alignSelf: "stretch", justifyContent: "space-between" },
  rowButton: { flex: 1, alignItems: "center", paddingVertical: 12, borderRadius: 12, backgroundColor: "#17191b" },
  qrFrame: { backgroundColor: "#ffffff", padding: 16, borderRadius: 16 },
  cameraFrame: { width: 280, height: 280, borderRadius: 18, overflow: "hidden", backgroundColor: "#000" },
});
