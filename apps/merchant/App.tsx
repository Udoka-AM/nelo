/**
 * Nelo Merchant — the terminal.
 *
 * The merchant types an amount in their own currency and shows a code. The
 * customer pays with whatever wallet they already have; nothing here says the
 * word crypto, and nothing about the flow requires the customer to install
 * anything.
 *
 * Week 2 scope: amount entry, conversion, the Solana Pay code, the day-book,
 * the balance — held in dollars, shown in the merchant's own currency — and
 * onboarding behind an embedded wallet. The payout leg comes next; see
 * docs/DELIVERABLES.md.
 *
 * There are two ways in, and the till does not care which was used: Mobile
 * Wallet Adapter for a merchant who already has a wallet, and a Privy embedded
 * wallet for one who does not. MWA is required by the hackathon rules, so the
 * embedded route is **additive** — and it is the route that makes step 2's
 * done-when true: setup completed without ever seeing a key.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import {
  Button,
  Card,
  color,
  Figure,
  Header,
  Heading,
  Hero,
  Label,
  Muted,
  Notice,
  radius,
  Row,
  Screen,
  Small,
  space,
  Spinner,
  TextButton,
  Title,
  touch,
  type,
} from "@nelo/ui";
import { StatusBar } from "expo-status-bar";
import QRCode from "react-native-qrcode-svg";
import * as Crypto from "expo-crypto";
import {
  closeOfDay,
  dayLabel,
  formatTime,
  groupByDay,
  localDayKey,
  type Sale,
} from "@nelo/ledger";
import { currentBalance, type Balance } from "./src/balance";
import { record, recent } from "./src/daybook";
import { currentRate, type Quoted } from "./src/rate";
import { connect, signTransactions } from "./src/wallet";
import { remember, restore, type MerchantAccount } from "./src/account";
import { PrivyProvider } from "@privy-io/expo";
import { canOnboardWithPhone, privy, rpc } from "./src/config";
import Onboarding from "./src/Onboarding";
import ScanPayment from "./src/Scan";
import CloseOfDay from "./src/CloseOfDay";
import Rebate from "./src/Rebate";
import CashOut, { PrivyCashOut } from "./src/CashOut";
import { syncPayers } from "./src/sync";
import { settleVouchers } from "./src/settle";
import { voucherStore } from "./src/offline";
import {
  awaitPayment,
  encodeTransferRequest,
  referenceFromBytes,
  type PaymentOutcome,
  formatDollars,
  formatLocalAmount,
  formatMoney,
  formatTokenAmount,
  localToTokenBaseUnits,
} from "@nelo/pay";

// The rate is a fixed quote, NOT a live feed — Pyth replaces this, and until it
// does every figure on screen is illustrative. The merchant wallet is real: it
// comes from Mobile Wallet Adapter, and Nelo never holds the key.
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const CURRENCY = { code: "NGN", symbol: "₦", minorDigits: 2 };
// Configurable; see src/config.ts for why the public endpoint is not enough
// once detection polls for real.
const RPC_URL = rpc;

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "00", "0", "⌫"];
/** Minor units per naira. */
const MINOR = 10n ** BigInt(CURRENCY.minorDigits);

function Till() {
  // Held as minor units so no float ever touches a price.
  const [minor, setMinor] = useState(0n);
  const [charging, setCharging] = useState(false);
  const [merchant, setMerchant] = useState<MerchantAccount | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<PaymentOutcome | null>(null);
  /** Set when polling has failed repeatedly — the terminal cannot see the chain. */
  const [pollTrouble, setPollTrouble] = useState(false);
  const [sales, setSales] = useState<Sale[]>([]);
  const [quoted, setQuoted] = useState<Quoted | null>(null);
  const [balance, setBalance] = useState<Balance | null>(null);
  const [showDaybook, setShowDaybook] = useState(false);
  const [showClose, setShowClose] = useState(false);
  const [showRebate, setShowRebate] = useState(false);
  const [cashingOut, setCashingOut] = useState(false);
  /** The customer has no signal, so the till scans their code instead. */
  const [scanning, setScanning] = useState(false);
  /** Offline payments taken and not yet settled. */
  const [owed, setOwed] = useState(0);
  const [settling, setSettling] = useState(false);
  const [settleNote, setSettleNote] = useState<string | null>(null);

  // The merchant's own clock decides which day a sale belongs to.
  const tz = useMemo(() => -new Date().getTimezoneOffset(), []);
  const today = useMemo(
    () => closeOfDay(sales, localDayKey(Date.now(), tz), tz),
    [sales, tz],
  );
  const [restoring, setRestoring] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [signingUp, setSigningUp] = useState(false);

  useEffect(() => {
    restore()
      .then(setMerchant)
      .catch(() => {})
      .finally(() => setRestoring(false));
    recent().then(setSales).catch(() => {});
    currentRate(CURRENCY.code).then(setQuoted).catch(() => {});
  }, []);

  async function onConnect() {
    setConnecting(true);
    try {
      const account = await connect();
      if (account) setMerchant(account);
    } catch (e) {
      // A declined authorisation lands here too; say what happened rather than
      // failing silently, because the merchant is standing at a counter.
      Alert.alert(
        "Could not connect",
        e instanceof Error ? e.message : "No Solana wallet responded on this device.",
      );
    } finally {
      setConnecting(false);
    }
  }

  // Held in dollars, shown in the merchant's currency. Refreshed when the
  // wallet connects and after every sale that settles — not on a timer, because
  // a till that polls in the background is a till that burns a prepaid data
  // bundle for a number nobody is looking at.
  const refreshBalance = useCallback(async () => {
    if (!merchant || !quoted) return;
    try {
      setBalance(
        await currentBalance(RPC_URL, merchant.address, USDC_DEVNET, quoted.rate, quoted.live),
      );
    } catch {
      // Leave the last known figure on screen. Replacing it with a confident
      // zero because the network blinked is worse than showing it stale.
    }
  }, [merchant, quoted]);

  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  const refreshOwed = useCallback(async () => {
    try {
      const entries = await voucherStore.all();
      setOwed(entries.filter((e) => e.status === "pending").length);
    } catch {
      // The count is a convenience; the queue itself is untouched.
    }
  }, []);

  // Refresh the payer list whenever the till opens with a merchant. Offline,
  // this fails quietly and the list already on the phone is used.
  useEffect(() => {
    if (!merchant) return;
    void syncPayers(USDC_DEVNET).catch(() => {});
    void refreshOwed();
  }, [merchant, refreshOwed]);

  async function onSettle() {
    if (!merchant) return;
    setSettling(true);
    setSettleNote(null);
    try {
      // A fresh payer list first: it is also the freshest view of which
      // payers have been frozen since the till last looked.
      await syncPayers(USDC_DEVNET).catch(() => {});
      const settled = await settleVouchers(merchant, USDC_DEVNET);
      if (settled.kind !== "round") {
        setSettleNote(settled.reason);
      } else {
        const r = settled.report;
        const parts = [
          r.settled.length ? `${r.settled.length} paid` : "",
          r.sent ? `${r.sent} sent, waiting to confirm` : "",
          r.refused.length ? `${r.refused.length} refused` : "",
          r.held.length ? `${r.held.length} need a look` : "",
          r.expired.length ? `${r.expired.length} expired` : "",
          settled.conflictsReported ? `${settled.conflictsReported} double spend reported` : "",
        ].filter(Boolean);
        setSettleNote(
          r.offline ? "No signal — try again when you are online." : parts.join(" · ") || "Nothing due yet.",
        );
      }
      setSales(await recent());
      void refreshBalance();
    } catch (e) {
      setSettleNote(e instanceof Error ? e.message : "Could not settle.");
    } finally {
      setSettling(false);
      void refreshOwed();
    }
  }

  const tokenAmount = useMemo(
    () => (quoted ? formatTokenAmount(localToTokenBaseUnits(minor, quoted.rate)) : "—"),
    [minor, quoted],
  );

  const url = useMemo(() => {
    if (minor === 0n) return null;
    if (!merchant || !reference) return null;
    return encodeTransferRequest({
      recipient: merchant.address,
      amount: tokenAmount,
      splToken: USDC_DEVNET,
      // The marker the terminal watches the chain for.
      reference: [reference],
      label: "Nelo",
      message: `${CURRENCY.symbol}${formatLocalAmount(minor, CURRENCY.minorDigits)}`,
    });
  }, [minor, tokenAmount, merchant, reference]);

  // Watch for the payment while the code is on screen.
  useEffect(() => {
    if (!charging || !merchant || !reference || !quoted) return;
    const controller = new AbortController();
    setOutcome(null);
    setPollTrouble(false);
    awaitPayment(
      RPC_URL,
      reference,
      {
        recipient: merchant.address,
        splToken: USDC_DEVNET,
        amountBaseUnits: localToTokenBaseUnits(minor, quoted!.rate),
      },
      {
        signal: controller.signal,
        // The code is on screen until the merchant takes it down, so the watch
        // runs that long too. A two-minute deadline meant the terminal quietly
        // stopped looking while still showing a live code.
        timeoutMs: null,
        intervalMs: 2_500,
        // Three consecutive failures is not a blink. Saying so beats a spinner
        // that means "no payment yet" and "I have been broken this whole time"
        // with the same pixels.
        onPollError: (_error, consecutive) => {
          if (!controller.signal.aborted) setPollTrouble(consecutive >= 3);
        },
      },
    )
      .then(async (result) => {
        if (controller.signal.aborted) return;
        setOutcome(result);
        if (result.status !== "paid") return;
        // `record` is keyed on the reference and ignores duplicates, so a
        // remount cannot book the same takings twice.
        await record({
          reference,
          signature: result.signature,
          localMinor: minor,
          currency: CURRENCY.code,
          amountBaseUnits: result.amountBaseUnits,
          mint: USDC_DEVNET,
          at: Date.now(),
          overpaid: result.overpaid,
        });
        setSales(await recent());
        // The money has landed; the balance on the till should say so.
        void refreshBalance();
      })
      .catch(() => {});
    return () => controller.abort();
  }, [charging, merchant, reference, minor, quoted, refreshBalance]);

  function startCharge() {
    // A fresh reference per sale, or two customers paying the same price would
    // be indistinguishable and the second sale would settle the first.
    setReference(referenceFromBytes(Crypto.getRandomBytes(32)));
    setOutcome(null);
    setPollTrouble(false);
    setCharging(true);
  }

  function endCharge() {
    setCharging(false);
    setReference(null);
    setOutcome(null);
    setPollTrouble(false);
  }

  function press(key: string) {
    // Whole naira, typed left to right, the way a price is said. A stall does
    // not price in kobo, and the old decimal key did nothing: 2-5-0-0 charged
    // ₦25.00. "00" is there because most prices end in it.
    setMinor((m) => {
      const whole = m / MINOR;
      const next = key === "⌫" ? whole / 10n : key === "00" ? whole * 100n : whole * 10n + BigInt(key);
      return next > 10n ** 10n ? m : next * MINOR;
    });
  }

  const money = (m: bigint) => formatMoney(m, CURRENCY);
  const dollarsFor = (m: bigint) => (quoted ? formatDollars(localToTokenBaseUnits(m, quoted.rate)) : "");

  if (restoring) {
    return (
      <Screen center scroll={false}>
        <StatusBar style="light" />
        <Spinner />
      </Screen>
    );
  }

  if (!merchant && signingUp) {
    return (
      <View style={styles.bare}>
        <StatusBar style="light" />
        <Onboarding
          onComplete={(account) => {
            // Written here rather than inside onboarding, which knows nothing
            // about storage. The MWA path writes its own record instead,
            // because it has an auth token to store at the same moment.
            void remember(account);
            setMerchant(account);
            setSigningUp(false);
          }}
          onUseWallet={() => setSigningUp(false)}
        />
      </View>
    );
  }

  if (!merchant) {
    return (
      <Screen center>
        <StatusBar style="light" />
        <Title>Take payments on this phone</Title>
        <Muted>
          Connect the wallet you already use. Nelo never holds your key — it only needs somewhere to send your money.
        </Muted>
        <Button
          label={connecting ? "Waiting for your wallet…" : "Connect wallet"}
          busy={connecting}
          onPress={() => void onConnect()}
        />
        {/* Offered only when this build has a Privy app ID. Without one the
            button could only ever fail, and the failure would land on the
            merchant as though they had mistyped something. */}
        {canOnboardWithPhone ? (
          <Button
            kind="secondary"
            label="No wallet? Set one up with your phone number"
            disabled={connecting}
            onPress={() => setSigningUp(true)}
          />
        ) : null}
      </Screen>
    );
  }

  if (cashingOut && merchant) {
    const common = {
      owner: merchant.address,
      payout: merchant.payout,
      balanceBaseUnits: balance?.baseUnits ?? null,
      rate: quoted?.rate ?? null,
      currency: CURRENCY,
      onPayoutSaved: (payout: string) => {
        const updated = { ...merchant, payout };
        setMerchant(updated);
        void remember(updated).catch(() => {});
      },
      onDone: () => {
        setCashingOut(false);
        void refreshBalance();
      },
    };
    return (
      <>
        <StatusBar style="light" />
        {merchant.kind === "embedded" && privy ? (
          <PrivyCashOut {...common} />
        ) : (
          <CashOut {...common} sign={async (wire) => (await signTransactions([wire]))[0]!} />
        )}
      </>
    );
  }

  if (showRebate) {
    return (
      <>
        <StatusBar style="light" />
        <Rebate sales={sales} tz={tz} onDone={() => setShowRebate(false)} />
      </>
    );
  }

  if (showClose) {
    return (
      <>
        <StatusBar style="light" />
        <CloseOfDay sales={sales} currency={CURRENCY} tz={tz} onDone={() => setShowClose(false)} />
      </>
    );
  }

  if (showDaybook) {
    const days = groupByDay(sales, tz);
    return (
      <Screen>
        <StatusBar style="light" />
        <Header title="Day-book" actions={[{ label: "Done", onPress: () => setShowDaybook(false) }]} />
        <NavCard title="Close the day" sub="What was sold, what arrived, what is still coming" onPress={() => setShowClose(true)} />
        <NavCard title="Your rebate" sub="Cash or SKR, from next month" onPress={() => setShowRebate(true)} />
        {days.length === 0 ? (
          <Muted>No sales yet. Takings appear here as they arrive.</Muted>
        ) : (
          days.map(({ day, sales: daySales, totals }) => (
            <View key={day} style={styles.day}>
              <Row
                label={dayLabel(day, Date.now(), tz)}
                sub={`${totals.count} ${totals.count === 1 ? "sale" : "sales"}${totals.overpaidCount > 0 ? ` · ${totals.overpaidCount} overpaid` : ""}`}
                value={money(totals.localMinor)}
                tone="positive"
                strong
              />
              {daySales.map((sale) => (
                <View key={sale.reference} style={styles.sale} accessible accessibilityLabel={`${formatTime(sale.at, tz)}, ${money(sale.localMinor)}`}>
                  <Small>{formatTime(sale.at, tz)}</Small>
                  <Figure>{money(sale.localMinor)}</Figure>
                </View>
              ))}
            </View>
          ))
        )}
      </Screen>
    );
  }

  if (charging && outcome?.status === "paid") {
    return (
      <Screen center>
        <StatusBar style="light" />
        <Text style={styles.mark} accessibilityLabel="Paid">✓</Text>
        <Title tone="positive" center>Paid</Title>
        <Hero center>{money(minor)}</Hero>
        {outcome.overpaid ? (
          <Notice tone="caution">The customer paid more than asked: {formatDollars(outcome.amountBaseUnits)} arrived.</Notice>
        ) : null}
        <Button
          label="New sale"
          onPress={() => {
            setMinor(0n);
            endCharge();
          }}
        />
      </Screen>
    );
  }

  if (charging && scanning && merchant && quoted) {
    return (
      <View style={styles.bare}>
        <StatusBar style="light" />
        <ScanPayment
          merchant={merchant.address}
          chargedBaseUnits={localToTokenBaseUnits(minor, quoted.rate)}
          chargedLocalMinor={minor}
          currency={CURRENCY}
          onDone={(took) => {
            setScanning(false);
            void refreshOwed();
            if (took) {
              setMinor(0n);
              endCharge();
            }
          }}
        />
      </View>
    );
  }

  if (charging && url) {
    return (
      <Screen center>
        <StatusBar style="light" />
        <Label center>Show this to your customer</Label>
        <Hero center>{money(minor)}</Hero>
        <View style={styles.qrFrame} accessible accessibilityLabel={`Payment code for ${money(minor)}`}>
          <QRCode value={url} size={232} backgroundColor={color.qrBackground} color={color.qrForeground} />
        </View>
        <Small center>{dollarsFor(minor)} · any Solana wallet can pay</Small>
        <View style={styles.status} accessibilityLiveRegion="polite">
          {outcome === null ? (
            pollTrouble ? (
              <Notice tone="danger">Cannot reach the network. A payment may not show here yet.</Notice>
            ) : (
              <>
                <ActivityIndicator color={color.textMuted} size="small" />
                <Muted>Waiting for payment…</Muted>
              </>
            )
          ) : outcome.status === "invalid" ? (
            <Notice tone="danger">{outcome.reason}</Notice>
          ) : outcome.status === "timeout" ? (
            <Notice tone="caution">No payment yet. The code is still valid.</Notice>
          ) : null}
        </View>
        {/* The other way to be paid: the customer's phone has no signal, so
            it shows a code and this till reads it. */}
        <Button kind="secondary" label="No signal? Scan the customer's code" onPress={() => setScanning(true)} />
        <TextButton label="Cancel" onPress={endCharge} />

        {/* Development builds only. Two debugging sessions have now turned on
            "what was actually in that QR" and "which key is the terminal
            watching", and both were unanswerable from the outside — the URL
            lives in a QR nobody can read back, and the reference is a random
            key that exists only in memory. A merchant never sees this; it is
            gated on __DEV__. Long-press to copy, or look the reference up on
            an explorer: if no transaction names it, the customer's wallet
            never attached it. */}
        {__DEV__ ? (
          <View style={styles.debug}>
            <Label>Reference</Label>
            <Small selectable>{reference}</Small>
            <Label>Request</Label>
            <Small selectable>{url}</Small>
          </View>
        ) : null}
      </Screen>
    );
  }

  const canCharge = minor > 0n && !!quoted;
  return (
    <Screen scroll={false}>
      <StatusBar style="light" />
      <Card>
        <View style={styles.balanceTop}>
          <Label>Balance</Label>
          <TextButton label="Cash out ›" tone="positive" onPress={() => setCashingOut(true)} accessibilityLabel="Cash out to your bank" />
        </View>
        {/* Held in dollars, shown in naira. The merchant is told both: the
            familiar number is the point, and so is what is underneath it. */}
        <Hero>{balance ? money(balance.localMinor) : "—"}</Hero>
        <Small>
          {balance ? `${formatDollars(balance.baseUnits)} held in US dollars` : "Checking…"}
          {balance && !balance.liveRate ? " · at a fixed rate" : ""}
        </Small>
      </Card>

      <Card onPress={() => setShowDaybook(true)} accessibilityLabel={`Today, ${money(today.localMinor)}, ${today.count} sales. Open the day-book`}>
        <View style={styles.today}>
          <Muted>Today</Muted>
          <View style={styles.todayRight}>
            <Figure>{money(today.localMinor)}</Figure>
            <Small>
              {today.count} {today.count === 1 ? "sale" : "sales"} ›
            </Small>
          </View>
        </View>
      </Card>

      {owed > 0 || settleNote ? (
        <Notice
          tone={owed > 0 ? "caution" : "positive"}
          {...(owed > 0 ? { action: { label: settling ? "Settling…" : "Settle now", onPress: () => void onSettle(), accessibilityLabel: "Settle offline payments" } } : {})}
        >
          {owed > 0 ? `${owed} offline ${owed === 1 ? "payment" : "payments"} to settle` : "All offline payments settled"}
          {settleNote ? `\n${settleNote}` : ""}
        </Notice>
      ) : null}

      <View style={styles.amountBox}>
        <Text style={styles.amount} numberOfLines={1} adjustsFontSizeToFit accessibilityLabel={`Amount ${money(minor)}`}>
          {money(minor)}
        </Text>
        {minor === 0n ? <Muted>Type the price</Muted> : <Small>{dollarsFor(minor)}</Small>}
        {quoted && !quoted.live ? <Small tone="caution">{quoted.note ?? "Rate is fixed, not live"}</Small> : null}
      </View>

      <View style={styles.keypad}>
        {KEYS.map((key) => (
          <Pressable
            key={key}
            style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
            onPress={() => press(key)}
            accessibilityRole="button"
            accessibilityLabel={key === "⌫" ? "Delete" : key === "00" ? "Double zero" : key}
          >
            <Text style={styles.keyText}>{key}</Text>
          </Pressable>
        ))}
      </View>

      <Button label={canCharge ? `Charge ${money(minor)}` : "Charge"} disabled={!canCharge} onPress={startCharge} />
    </Screen>
  );
}

/** A row that opens another screen. */
function NavCard({ title, sub, onPress }: { title: string; sub: string; onPress: () => void }) {
  return (
    <Card onPress={onPress} accessibilityLabel={`${title}. ${sub}`}>
      <View style={styles.nav}>
        <View style={{ flexShrink: 1 }}>
          <Heading>{title}</Heading>
          <Small>{sub}</Small>
        </View>
        <Muted>›</Muted>
      </View>
    </Card>
  );
}

/**
 * The provider, and the reason it is conditional.
 *
 * Privy's hooks throw without a provider above them, so the till is wrapped
 * when this build has an app ID and rendered bare when it does not. The bare
 * case is not a degraded mode to apologise for: Mobile Wallet Adapter is what
 * the rules require, and it is complete on its own. What is missing without an
 * app ID is only the route in for a merchant who has no wallet yet.
 *
 * Wrapping unconditionally with a placeholder ID would be worse — the hooks
 * would initialise, the SDK would reject the ID, and the failure would surface
 * at the least helpful moment: mid-onboarding, in front of a customer.
 */
export default function App() {
  if (!privy) return <Till />;
  return (
    <PrivyProvider appId={privy.appId} clientId={privy.clientId}>
      <Till />
    </PrivyProvider>
  );
}

const styles = StyleSheet.create({
  bare: { flex: 1, backgroundColor: color.bg },
  mark: { color: color.positive, fontSize: 64, textAlign: "center" },
  qrFrame: { backgroundColor: color.qrBackground, padding: space.lg, borderRadius: radius.lg, alignSelf: "center" },
  status: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, minHeight: touch },
  debug: { marginTop: space.lg, borderTopWidth: 1, borderTopColor: color.border, paddingTop: space.md, gap: space.xs, alignSelf: "stretch" },
  balanceTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: -space.sm, marginBottom: -space.sm },
  today: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  todayRight: { alignItems: "flex-end" },
  amountBox: { flex: 1, justifyContent: "center", alignItems: "center", gap: space.sm },
  amount: { color: color.text, fontSize: type.display, fontWeight: "700", letterSpacing: -1.5, fontVariant: ["tabular-nums"] },
  keypad: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: space.sm },
  key: { width: "31.5%", height: 56, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: color.surface },
  keyPressed: { backgroundColor: color.surfaceHigh },
  keyText: { color: color.text, fontSize: type.title, fontWeight: "500" },
  day: { gap: 0 },
  sale: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: touch, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border },
  nav: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.md },
});
