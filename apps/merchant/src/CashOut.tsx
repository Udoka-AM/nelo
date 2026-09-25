/**
 * Cash out to the bank.
 *
 * The merchant says how much, in naira, and to which account; paj.cash's name
 * enquiry shows whose account it is before anything moves. Then one approval
 * in their wallet, and paj.cash pays the bank. The merchant needs no SOL: the
 * relayer pays the transfer's fee.
 *
 * The steps, and resuming them, are `@nelo/cashout`, under test. This screen
 * keeps one thing of its own: the id of a cash-out in progress, saved before
 * it starts, so a crash or a dead battery resumes the same cash-out rather
 * than starting a second one.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as Crypto from "expo-crypto";
import {
  cashOut,
  relayService,
  ServiceError,
  settleService,
  type CashoutRecord,
  type TransactionSigner,
} from "@nelo/cashout";
import { formatLocalAmount, formatTokenAmount, localToTokenBaseUnits, type Rate } from "@nelo/pay";
import { relayToken, relayUrl, settleToken, settleUrl } from "./config";
import { loadSetting, saveSetting } from "./daybook";
import { usePrivySigner } from "./privySigner";

const PENDING = "cashout-pending";

interface Pending {
  id: string;
  destination: string;
  amount: string;
  /** For the screen: what the merchant asked for, and who it is going to. */
  localMinor: string;
  to: string;
}

export interface CashOutProps {
  owner: string;
  /** Saved from onboarding or an earlier cash-out: `bank:NG:058:0123456789`. */
  payout: string | undefined;
  balanceBaseUnits: bigint | null;
  rate: Rate | null;
  currency: { code: string; symbol: string; minorDigits: number };
  /** Null while the wallet is not ready. */
  sign: TransactionSigner | null;
  onPayoutSaved: (canonical: string) => void;
  onDone: () => void;
}

type Stage =
  | { step: "form" }
  | { step: "working"; label: string }
  | { step: "status"; cashout: CashoutRecord; to: string; localMinor: bigint }
  | { step: "problem"; message: string; canRetry: boolean };

const services = () => ({
  settle: settleService({ url: settleUrl!, ...(settleToken ? { token: settleToken } : {}) }),
  relay: relayService({ url: relayUrl!, ...(relayToken ? { token: relayToken } : {}) }),
});

const FINAL = new Set(["paid", "failed"]);

export default function CashOut(props: CashOutProps) {
  const [stage, setStage] = useState<Stage>({ step: "working", label: "Loading…" });
  const [pending, setPending] = useState<Pending | null>(null);
  const [amountText, setAmountText] = useState("");
  const [banks, setBanks] = useState<{ code: string; name: string }[]>([]);
  const [filter, setFilter] = useState("");
  const [bank, setBank] = useState<{ code: string; name: string } | null>(null);
  const [account, setAccount] = useState("");
  const [holder, setHolder] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const alive = useRef(true);

  const configured = !!settleUrl && !!relayUrl;

  // A saved destination is pre-filled; its holder is looked up again, since
  // an account name is the one check a merchant can make with their own eyes.
  useEffect(() => {
    alive.current = true;
    void (async () => {
      const saved = await loadSetting(PENDING).catch(() => null);
      if (saved) {
        try {
          setPending(JSON.parse(saved) as Pending);
        } catch {
          /* a pending record that will not parse is dropped */
        }
      }
      if (!configured) return setStage({ step: "form" });
      const { settle } = services();
      const list = await settle.banks().catch(() => []);
      if (!alive.current) return;
      setBanks(list);
      const m = /^bank:NG:(\d{3,6}):(\d{10})$/.exec(props.payout ?? "");
      if (m) {
        const found = list.find((b) => b.code === m[1]) ?? { code: m[1]!, name: `Bank ${m[1]}` };
        setBank(found);
        setAccount(m[2]!);
        settle.resolve(m[1]!, m[2]!).then((r) => alive.current && setHolder(r.accountName)).catch(() => {});
      }
      setStage({ step: "form" });
    })();
    return () => {
      alive.current = false;
    };
  }, [configured, props.payout]);

  const localMinor = parseLocal(amountText, props.currency.minorDigits);
  const tokenMinor = localMinor !== null && props.rate ? localToTokenBaseUnits(localMinor, props.rate) : null;
  const tooMuch = tokenMinor !== null && props.balanceBaseUnits !== null && tokenMinor > props.balanceBaseUnits;
  const destination = bank && /^\d{10}$/.test(account) ? `bank:NG:${bank.code}:${account}` : null;
  const ready = !!destination && !!holder && tokenMinor !== null && tokenMinor > 0n && !tooMuch && !!props.sign;

  async function check() {
    if (!bank || !/^\d{10}$/.test(account)) return;
    setChecking(true);
    setHolder(null);
    setNote(null);
    try {
      const r = await services().settle.resolve(bank.code, account);
      setHolder(r.accountName);
    } catch (e) {
      setNote(e instanceof ServiceError && e.status === 404 ? "That account could not be found. Check the number and the bank." : "Could not check the account. Try again with signal.");
    } finally {
      setChecking(false);
    }
  }

  const poll = useCallback(async (id: string, to: string, localMinorValue: bigint) => {
    for (let i = 0; i < 60 && alive.current; i++) {
      try {
        const c = await services().settle.get(id);
        if (!alive.current) return;
        setStage({ step: "status", cashout: c, to, localMinor: localMinorValue });
        if (FINAL.has(c.state)) {
          await saveSetting(PENDING, "").catch(() => {});
          setPending(null);
          return;
        }
      } catch {
        /* keep the last known state on screen and try again */
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }, []);

  async function run(p: Pending) {
    if (!props.sign) return;
    setStage({ step: "working", label: "Opening the payout…" });
    try {
      const outcome = await cashOut(
        { id: p.id, merchant: props.owner, destination: p.destination, amount: BigInt(p.amount) },
        { ...services(), sign: async (wire) => {
          if (alive.current) setStage({ step: "working", label: "Approve the transfer in your wallet…" });
          return props.sign!(wire);
        } },
      );
      if (outcome.kind === "refused" || outcome.kind === "wait") {
        if (outcome.kind === "refused") {
          await saveSetting(PENDING, "").catch(() => {});
          setPending(null);
        }
        setStage({ step: "problem", message: outcome.reason, canRetry: outcome.kind === "wait" });
        return;
      }
      setStage({ step: "status", cashout: outcome.cashout, to: p.to, localMinor: BigInt(p.localMinor) });
      void poll(p.id, p.to, BigInt(p.localMinor));
    } catch (e) {
      const message =
        e instanceof ServiceError && e.login
          ? "Cash-outs are paused on Nelo's side. Your money has not moved; try again later."
          : `${e instanceof Error ? e.message : "Something went wrong"}. Nothing is sent twice: try again and it continues where it stopped.`;
      setStage({ step: "problem", message, canRetry: true });
    }
  }

  async function start() {
    if (!ready || !destination || tokenMinor === null || localMinor === null) return;
    const p: Pending = {
      id: Crypto.randomUUID(),
      destination,
      amount: tokenMinor.toString(),
      localMinor: localMinor.toString(),
      to: `${holder} · ${bank!.name} ••••${account.slice(-4)}`,
    };
    // Saved before anything is asked of anyone: the same id is used however
    // many times this has to be run again.
    await saveSetting(PENDING, JSON.stringify(p));
    setPending(p);
    props.onPayoutSaved(destination);
    await run(p);
  }

  const money = (minor: bigint) => `${props.currency.symbol}${formatLocalAmount(minor, props.currency.minorDigits)}`;

  if (!configured) {
    return (
      <Shell onDone={props.onDone}>
        <Text style={styles.text}>Cash-out is not set up in this build. Your money is safe in your account.</Text>
      </Shell>
    );
  }

  if (stage.step === "working") {
    return (
      <Shell onDone={props.onDone}>
        <ActivityIndicator color="#4fb98f" />
        <Text style={styles.text}>{stage.label}</Text>
      </Shell>
    );
  }

  if (stage.step === "problem") {
    return (
      <Shell onDone={props.onDone}>
        <Text style={styles.title}>Not sent</Text>
        <Text style={styles.text}>{stage.message}</Text>
        {stage.canRetry && pending ? (
          <Pressable style={styles.primary} onPress={() => void run(pending)} accessibilityRole="button">
            <Text style={styles.primaryText}>Try again</Text>
          </Pressable>
        ) : (
          <Pressable style={styles.primary} onPress={() => setStage({ step: "form" })} accessibilityRole="button">
            <Text style={styles.primaryText}>Back</Text>
          </Pressable>
        )}
      </Shell>
    );
  }

  if (stage.step === "status") {
    const c = stage.cashout;
    const words: Record<string, string> = {
      "awaiting-funds": "Waiting for your transfer",
      funded: "Sent. paj.cash is receiving it",
      processing: "paj.cash is paying your bank",
      paid: "Paid to your bank",
      failed: "The payout failed",
    };
    const bankMinor = c.localMinor ? BigInt(c.localMinor) : stage.localMinor;
    return (
      <Shell onDone={props.onDone}>
        {c.state === "paid" ? <Text style={styles.good}>✓</Text> : null}
        <Text style={styles.title}>{words[c.state] ?? c.state}</Text>
        <Text style={styles.big}>{money(bankMinor)}</Text>
        <Text style={styles.text}>to {stage.to}</Text>
        <Text style={styles.small}>{c.detail}</Text>
        {!FINAL.has(c.state) ? <ActivityIndicator color="#8d9299" /> : null}
      </Shell>
    );
  }

  // The form.
  const shown = filter.trim()
    ? banks.filter((b) => b.name.toLowerCase().includes(filter.trim().toLowerCase())).slice(0, 8)
    : [];
  return (
    <Shell onDone={props.onDone}>
      {pending ? (
        <View style={styles.resume}>
          <Text style={styles.text}>A cash-out of {money(BigInt(pending.localMinor))} to {pending.to} did not finish.</Text>
          <Pressable style={styles.primary} onPress={() => void run(pending)} disabled={!props.sign} accessibilityRole="button">
            <Text style={styles.primaryText}>Finish it</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <Text style={styles.label}>AMOUNT</Text>
          <TextInput
            style={styles.input}
            value={amountText}
            onChangeText={setAmountText}
            keyboardType="decimal-pad"
            placeholder={`${props.currency.symbol}0`}
            placeholderTextColor="#5f646b"
          />
          {props.balanceBaseUnits !== null ? (
            <Text style={styles.small}>
              {formatTokenAmount(props.balanceBaseUnits)} USDC in your account
              {tokenMinor !== null ? ` · this is ${formatTokenAmount(tokenMinor)} USDC` : ""}
            </Text>
          ) : null}
          {tooMuch ? <Text style={styles.warn}>That is more than your balance.</Text> : null}

          <Text style={styles.label}>TO</Text>
          {bank ? (
            <Pressable onPress={() => { setBank(null); setHolder(null); }} accessibilityRole="button">
              <Text style={styles.choice}>{bank.name} · change</Text>
            </Pressable>
          ) : (
            <>
              <TextInput style={styles.inputSmall} value={filter} onChangeText={setFilter} placeholder="Find your bank" placeholderTextColor="#5f646b" />
              {shown.map((b) => (
                <Pressable key={b.code} onPress={() => { setBank(b); setFilter(""); setHolder(null); }} accessibilityRole="button">
                  <Text style={styles.option}>{b.name}</Text>
                </Pressable>
              ))}
            </>
          )}
          <TextInput
            style={styles.inputSmall}
            value={account}
            onChangeText={(t) => { setAccount(t.replace(/\D/g, "").slice(0, 10)); setHolder(null); }}
            onEndEditing={() => void check()}
            keyboardType="number-pad"
            placeholder="10-digit account number"
            placeholderTextColor="#5f646b"
          />
          {checking ? <Text style={styles.small}>Checking the account…</Text> : null}
          {holder ? <Text style={styles.holder}>{holder}</Text> : null}
          {note ? <Text style={styles.warn}>{note}</Text> : null}
          {bank && account.length === 10 && !holder && !checking ? (
            <Pressable onPress={() => void check()} accessibilityRole="button">
              <Text style={styles.choice}>Check whose account this is</Text>
            </Pressable>
          ) : null}

          <Pressable style={[styles.primary, !ready && styles.disabled]} disabled={!ready} onPress={() => void start()} accessibilityRole="button">
            <Text style={styles.primaryText}>
              {localMinor ? `Cash out ${money(localMinor)}` : "Cash out"}
            </Text>
          </Pressable>
          {!props.sign ? <Text style={styles.small}>Your wallet is not ready yet.</Text> : null}
          <Text style={styles.small}>Paid by paj.cash to the account above. You approve one transfer; Nelo pays its fee.</Text>
        </>
      )}
    </Shell>
  );
}

function parseLocal(text: string, digits: number): bigint | null {
  const m = new RegExp(`^(\\d{1,12})(?:\\.(\\d{1,${digits}}))?$`).exec(text.replace(/,/g, "").trim());
  if (!m) return null;
  return BigInt(m[1]!) * 10n ** BigInt(digits) + BigInt((m[2] ?? "").padEnd(digits, "0") || "0");
}

function Shell({ children, onDone }: { children: React.ReactNode; onDone: () => void }) {
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.heading}>Cash out</Text>
        <Pressable onPress={onDone} accessibilityRole="button">
          <Text style={styles.link}>Done</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#101113", paddingTop: 64, paddingHorizontal: 20 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  heading: { color: "#e8e9ea", fontSize: 26, fontWeight: "700", letterSpacing: -0.6 },
  link: { color: "#8d9299", fontSize: 16, paddingHorizontal: 8 },
  body: { gap: 12, paddingBottom: 40 },
  title: { color: "#e8e9ea", fontSize: 22, fontWeight: "700" },
  big: { color: "#e8e9ea", fontSize: 34, fontWeight: "700", letterSpacing: -1 },
  label: { color: "#8d9299", fontSize: 12, letterSpacing: 1.5, marginTop: 8 },
  text: { color: "#8d9299", fontSize: 15.5, lineHeight: 23 },
  small: { color: "#6d7278", fontSize: 13, lineHeight: 19 },
  warn: { color: "#d4855e", fontSize: 14 },
  good: { color: "#4fb98f", fontSize: 56 },
  holder: { color: "#4fb98f", fontSize: 16, fontWeight: "700" },
  choice: { color: "#4fb98f", fontSize: 15.5, paddingVertical: 6 },
  option: { color: "#e8e9ea", fontSize: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#2a2c30" },
  resume: { gap: 12 },
  input: { color: "#e8e9ea", fontSize: 28, borderWidth: 1, borderColor: "#282b2f", borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16 },
  inputSmall: { color: "#e8e9ea", fontSize: 17, borderWidth: 1, borderColor: "#282b2f", borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16 },
  primary: { backgroundColor: "#1a6b4c", borderRadius: 14, paddingVertical: 18, alignItems: "center", marginTop: 12 },
  disabled: { backgroundColor: "#1d1f22" },
  primaryText: { color: "#ffffff", fontSize: 17, fontWeight: "700" },
});

/** A Privy merchant's cash-out: the same screen, signed through Privy. Render only inside PrivyProvider. */
export function PrivyCashOut(props: Omit<CashOutProps, "sign">) {
  const sign = usePrivySigner(props.owner);
  return <CashOut {...props} sign={sign} />;
}
