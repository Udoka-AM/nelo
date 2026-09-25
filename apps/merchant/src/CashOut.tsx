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
import { StyleSheet, Text, View } from "react-native";
import { Body, Button, Card, color, Field, Header, Hero, Label, Muted, Notice, Screen, Small, Spinner, TextButton, Title, type } from "@nelo/ui";
import * as Crypto from "expo-crypto";
import {
  cashOut,
  relayService,
  ServiceError,
  settleService,
  type CashoutRecord,
  type TransactionSigner,
} from "@nelo/cashout";
import { formatDollars, formatMoney, localToTokenBaseUnits, tokenBaseUnitsToLocalMinor, type Rate } from "@nelo/pay";
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

  const money = (minor: bigint) => formatMoney(minor, props.currency);
  const balanceLocal =
    props.balanceBaseUnits !== null && props.rate ? tokenBaseUnitsToLocalMinor(props.balanceBaseUnits, props.rate) : null;

  if (!configured) {
    return (
      <Shell onDone={props.onDone}>
        <Muted>Cash-out is not set up in this build. Your money is safe in your account.</Muted>
      </Shell>
    );
  }

  if (stage.step === "working") {
    return (
      <Shell onDone={props.onDone}>
        <Spinner label={stage.label} />
      </Shell>
    );
  }

  if (stage.step === "problem") {
    return (
      <Shell onDone={props.onDone}>
        <Title>Not sent</Title>
        <Muted>{stage.message}</Muted>
        {stage.canRetry && pending ? (
          <Button label="Try again" onPress={() => void run(pending)} />
        ) : (
          <Button label="Back" kind="secondary" onPress={() => setStage({ step: "form" })} />
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
        {c.state === "paid" ? <Text style={styles.mark}>✓</Text> : null}
        <Title tone={c.state === "paid" ? "positive" : c.state === "failed" ? "danger" : "default"}>{words[c.state] ?? c.state}</Title>
        <Hero>{money(bankMinor)}</Hero>
        <Muted>to {stage.to}</Muted>
        <Small>{c.detail}</Small>
        {!FINAL.has(c.state) ? <Spinner /> : null}
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
        <>
          <Notice tone="caution">
            A cash-out of {money(BigInt(pending.localMinor))} to {pending.to} did not finish.
          </Notice>
          <Button label="Finish it" disabled={!props.sign} onPress={() => void run(pending)} />
        </>
      ) : (
        <>
          <Field
            label="Amount"
            value={amountText}
            onChangeText={setAmountText}
            keyboardType="number-pad"
            placeholder={`${props.currency.symbol}0`}
            style={styles.amountInput}
            hint={
              balanceLocal !== null
                ? `${money(balanceLocal)} available${tokenMinor !== null ? ` · this is ${formatDollars(tokenMinor)}` : ""}`
                : undefined
            }
          />
          {balanceLocal !== null && balanceLocal > 0n ? (
            <TextButton
              label="Cash out everything"
              tone="positive"
              onPress={() => setAmountText((balanceLocal / 10n ** BigInt(props.currency.minorDigits)).toString())}
            />
          ) : null}
          {tooMuch ? <Notice tone="danger">That is more than your balance.</Notice> : null}

          <Label>To</Label>
          {bank ? (
            <Card onPress={() => { setBank(null); setHolder(null); }} accessibilityLabel={`${bank.name}. Change bank`}>
              <View style={styles.bankRow}>
                <Body>{bank.name}</Body>
                <Small tone="positive">Change</Small>
              </View>
            </Card>
          ) : (
            <>
              <Field label="Bank" value={filter} onChangeText={setFilter} placeholder="Type your bank's name" />
              {shown.map((b) => (
                <Card key={b.code} onPress={() => { setBank(b); setFilter(""); setHolder(null); }} accessibilityLabel={b.name}>
                  <Body>{b.name}</Body>
                </Card>
              ))}
            </>
          )}
          <Field
            label="Account number"
            value={account}
            onChangeText={(t) => { setAccount(t.replace(/\D/g, "").slice(0, 10)); setHolder(null); }}
            onEndEditing={() => void check()}
            keyboardType="number-pad"
            placeholder="10 digits"
          />
          {checking ? <Spinner label="Checking the account…" /> : null}
          {holder ? <Notice tone="positive">{holder}</Notice> : null}
          {note ? <Notice tone="danger">{note}</Notice> : null}
          {bank && account.length === 10 && !holder && !checking ? (
            <Button kind="secondary" label="Check whose account this is" onPress={() => void check()} />
          ) : null}

          <Button label={localMinor ? `Cash out ${money(localMinor)}` : "Cash out"} disabled={!ready} onPress={() => void start()} />
          {!props.sign ? <Small>Your wallet is not ready yet.</Small> : null}
          <Small>Paid by paj.cash to the account above. You approve one transfer; Nelo pays its fee.</Small>
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
    <Screen>
      <Header title="Cash out" actions={[{ label: "Done", onPress: onDone }]} />
      {children}
    </Screen>
  );
}

const styles = StyleSheet.create({
  mark: { color: color.positive, fontSize: 56 },
  amountInput: { fontSize: type.hero, fontWeight: "700", minHeight: 68 },
  bankRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
});

/** A Privy merchant's cash-out: the same screen, signed through Privy. Render only inside PrivyProvider. */
export function PrivyCashOut(props: Omit<CashOutProps, "sign">) {
  const sign = usePrivySigner(props.owner);
  return <CashOut {...props} sign={sign} />;
}
