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
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
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
  formatLocalAmount,
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

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "·", "0", "⌫"];

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
    if (key === "⌫") {
      setMinor((m) => m / 10n);
    } else if (key === "·") {
      // Minor units are implicit — typing is right-to-left, as on a till.
    } else {
      setMinor((m) => {
        const next = m * 10n + BigInt(key);
        return next > 10n ** 12n ? m : next; // stop at a sane ceiling
      });
    }
  }

  if (restoring) {
    return (
      <View style={[styles.screen, styles.centre]}>
        <StatusBar style="light" />
        <ActivityIndicator color="#4fb98f" />
      </View>
    );
  }

  if (!merchant && signingUp) {
    return (
      <View style={styles.screen}>
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
      <View style={styles.screen}>
        <StatusBar style="light" />
        <View style={styles.onboard}>
          <Text style={styles.onboardTitle}>Take payments on this phone</Text>
          <Text style={styles.onboardBody}>
            Connect the wallet you already use. Nelo never holds your key — it only needs
            somewhere to send your money.
          </Text>
          <Pressable
            style={[styles.primary, styles.onboardButton, connecting && styles.primaryDisabled]}
            disabled={connecting}
            onPress={onConnect}
            accessibilityRole="button"
          >
            <Text style={styles.primaryText}>
              {connecting ? "Waiting for your wallet…" : "Connect wallet"}
            </Text>
          </Pressable>
          {/* Offered only when this build has a Privy app ID. Without one the
              button could only ever fail, and the failure would land on the
              merchant as though they had mistyped something. */}
          {canOnboardWithPhone ? (
            <Pressable
              style={styles.secondary}
              disabled={connecting}
              onPress={() => setSigningUp(true)}
              accessibilityRole="button"
            >
              <Text style={styles.secondaryCentred}>
                I don't have a wallet — set one up with my phone number
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
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
      <View style={styles.screen}>
        <StatusBar style="light" />
        <View style={styles.bookHeader}>
          <Text style={styles.bookTitle}>Day-book</Text>
          <View style={styles.bookActions}>
            <Pressable onPress={() => setShowClose(true)} accessibilityRole="button">
              <Text style={styles.secondaryText}>Close the day</Text>
            </Pressable>
            <Pressable onPress={() => setShowDaybook(false)} accessibilityRole="button">
              <Text style={styles.secondaryText}>Done</Text>
            </Pressable>
          </View>
        </View>
        <ScrollView contentContainerStyle={styles.bookBody}>
          <Pressable style={styles.rebateRow} onPress={() => setShowRebate(true)} accessibilityRole="button">
            <Text style={styles.rebateLabel}>Your rebate: cash or SKR</Text>
            <Text style={styles.secondaryText}>›</Text>
          </Pressable>
          {days.length === 0 ? (
            <Text style={styles.empty}>No sales yet. Takings appear here as they settle.</Text>
          ) : (
            days.map(({ day, sales: daySales, totals }) => (
              <View key={day} style={styles.daySection}>
                <View style={styles.dayHeader}>
                  <Text style={styles.dayName}>{dayLabel(day, Date.now(), tz)}</Text>
                  <Text style={styles.dayTotal}>
                    {CURRENCY.symbol}
                    {formatLocalAmount(totals.localMinor, CURRENCY.minorDigits)}
                  </Text>
                </View>
                <Text style={styles.dayCount}>
                  {totals.count} {totals.count === 1 ? "sale" : "sales"}
                  {totals.overpaidCount > 0 ? ` · ${totals.overpaidCount} overpaid` : ""}
                </Text>
                {daySales.map((sale) => (
                  <View key={sale.reference} style={styles.saleRow}>
                    <Text style={styles.saleTime}>{formatTime(sale.at, tz)}</Text>
                    <Text style={styles.saleAmount}>
                      {CURRENCY.symbol}
                      {formatLocalAmount(sale.localMinor, CURRENCY.minorDigits)}
                    </Text>
                    <Text style={styles.saleToken}>
                      {formatTokenAmount(sale.amountBaseUnits)}
                    </Text>
                  </View>
                ))}
              </View>
            ))
          )}
        </ScrollView>
      </View>
    );
  }

  if (charging && outcome?.status === "paid") {
    return (
      <View style={styles.screen}>
        <StatusBar style="light" />
        <View style={styles.chargeBody}>
          <Text style={styles.paidMark}>✓</Text>
          <Text style={styles.paidTitle}>Paid</Text>
          <Text style={styles.chargeAmount}>
            {CURRENCY.symbol}
            {formatLocalAmount(minor, CURRENCY.minorDigits)}
          </Text>
          {outcome.overpaid ? (
            <Text style={styles.chargeSub}>
              Customer paid more than asked — {formatTokenAmount(outcome.amountBaseUnits)} USDC
            </Text>
          ) : null}
          <Pressable
            style={[styles.primary, styles.onboardButton]}
            onPress={() => {
              setMinor(0n);
              endCharge();
            }}
            accessibilityRole="button"
          >
            <Text style={styles.primaryText}>New sale</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  if (charging && scanning && merchant && quoted) {
    return (
      <View style={styles.screen}>
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
      <View style={styles.screen}>
        <StatusBar style="light" />
        <View style={styles.chargeBody}>
          <Text style={styles.chargeLabel}>Show this to your customer</Text>
          <Text style={styles.chargeAmount}>
            {CURRENCY.symbol}
            {formatLocalAmount(minor, CURRENCY.minorDigits)}
          </Text>
          <View style={styles.qrFrame}>
            <QRCode value={url} size={240} backgroundColor="#ffffff" color="#101113" />
          </View>
          <Text style={styles.chargeSub}>{tokenAmount} USDC · any Solana wallet</Text>
          <View style={styles.statusRow}>
            {outcome === null ? (
              <>
                <ActivityIndicator color="#8d9299" size="small" />
                <Text style={pollTrouble ? styles.statusBad : styles.statusWaiting}>
                  {pollTrouble
                    ? "Cannot reach the network — a payment may not show here"
                    : "Waiting for payment…"}
                </Text>
              </>
            ) : outcome.status === "invalid" ? (
              <Text style={styles.statusBad}>{outcome.reason}</Text>
            ) : outcome.status === "timeout" ? (
              <Text style={styles.statusBad}>No payment yet — the code is still valid</Text>
            ) : null}
          </View>
          {/* The other way to be paid: the customer's phone has no signal, so
              it shows a code and this till reads it. */}
          <Pressable style={styles.offlineButton} onPress={() => setScanning(true)} accessibilityRole="button">
            <Text style={styles.offlineButtonText}>Customer has no signal? Scan their code</Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={endCharge} accessibilityRole="button">
            <Text style={styles.secondaryText}>Cancel</Text>
          </Pressable>

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
              <Text style={styles.debugLabel}>REFERENCE</Text>
              <Text style={styles.debugText} selectable>
                {reference}
              </Text>
              <Text style={styles.debugLabel}>REQUEST</Text>
              <Text style={styles.debugText} selectable>
                {url}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <Pressable
        style={styles.balanceBar}
        onPress={() => setCashingOut(true)}
        accessibilityRole="button"
        accessibilityLabel="Cash out to your bank"
      >
        <View>
          <Text style={styles.balanceLabel}>BALANCE · CASH OUT ›</Text>
          <Text style={styles.balanceValue}>
            {CURRENCY.symbol}
            {balance ? formatLocalAmount(balance.localMinor, CURRENCY.minorDigits) : "—"}
          </Text>
        </View>
        <View style={styles.balanceAside}>
          {/* Held in dollars, shown in naira. The merchant is told both: the
              familiar number is the point, and so is what is underneath it. */}
          <Text style={styles.balanceHeld}>
            {balance ? `${formatTokenAmount(balance.baseUnits)} USDC` : "…"}
          </Text>
          <Text style={styles.balanceNote}>
            {balance && !balance.liveRate ? "at a fixed rate" : "held in dollars"}
          </Text>
        </View>
      </Pressable>

      <Pressable
        style={styles.todayBar}
        onPress={() => setShowDaybook(true)}
        accessibilityRole="button"
        accessibilityLabel="Open the day-book"
      >
        <Text style={styles.todayLabel}>Today</Text>
        <Text style={styles.todayValue}>
          {CURRENCY.symbol}
          {formatLocalAmount(today.localMinor, CURRENCY.minorDigits)}
          <Text style={styles.todayCount}>
            {"  "}
            {today.count} {today.count === 1 ? "sale" : "sales"}
          </Text>
        </Text>
      </Pressable>

      {owed > 0 || settleNote ? (
        <Pressable
          style={styles.owedBar}
          onPress={onSettle}
          disabled={settling || owed === 0}
          accessibilityRole="button"
          accessibilityLabel="Settle offline payments"
        >
          <Text style={styles.owedText}>
            {settling
              ? "Settling…"
              : owed > 0
                ? `${owed} offline ${owed === 1 ? "payment" : "payments"} to settle · Settle now`
                : "All offline payments settled"}
          </Text>
          {settleNote ? <Text style={styles.owedNote}>{settleNote}</Text> : null}
        </Pressable>
      ) : null}

      <View style={styles.amountBox}>
        <Text style={styles.currency}>{CURRENCY.code}</Text>
        <Text style={styles.amount} numberOfLines={1} adjustsFontSizeToFit>
          {CURRENCY.symbol}
          {formatLocalAmount(minor, CURRENCY.minorDigits)}
        </Text>
        <Text style={styles.converted}>
          {minor === 0n ? "Enter an amount" : `${tokenAmount} USDC`}
        </Text>
        {quoted && !quoted.live ? (
          <Text style={styles.rateWarning}>{quoted.note ?? "Rate is fixed, not live"}</Text>
        ) : null}
      </View>

      <View style={styles.keypad}>
        {KEYS.map((key) => (
          <Pressable
            key={key}
            style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
            onPress={() => press(key)}
            accessibilityRole="button"
            accessibilityLabel={key === "⌫" ? "Delete" : key}
          >
            <Text style={styles.keyText}>{key}</Text>
          </Pressable>
        ))}
      </View>

      <Pressable
        style={[styles.primary, (minor === 0n || !quoted) && styles.primaryDisabled]}
        disabled={minor === 0n || !quoted}
        onPress={startCharge}
        accessibilityRole="button"
      >
        <Text style={styles.primaryText}>Charge</Text>
      </Pressable>
    </View>
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
  screen: { flex: 1, backgroundColor: "#101113", paddingTop: 64, paddingHorizontal: 20 },
  centre: { alignItems: "center", justifyContent: "center" },
  onboard: { flex: 1, justifyContent: "center", gap: 16 },
  onboardTitle: { color: "#e8e9ea", fontSize: 30, fontWeight: "700", letterSpacing: -0.8 },
  onboardBody: { color: "#8d9299", fontSize: 16.5, lineHeight: 25 },
  onboardButton: { marginTop: 16, marginBottom: 0 },
  amountBox: { flex: 1, justifyContent: "center", alignItems: "center" },
  currency: { color: "#8d9299", fontSize: 12, letterSpacing: 2, marginBottom: 8 },
  amount: { color: "#e8e9ea", fontSize: 56, fontWeight: "700", letterSpacing: -1.5 },
  converted: { color: "#4fb98f", fontSize: 16, marginTop: 10 },
  rateWarning: { color: "#d4855e", fontSize: 12.5, marginTop: 8, textAlign: "center" },
  keypad: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  key: {
    width: "31%",
    aspectRatio: 1.7,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
    borderRadius: 14,
    backgroundColor: "#17191b",
  },
  keyPressed: { backgroundColor: "#22262a" },
  keyText: { color: "#e8e9ea", fontSize: 26, fontWeight: "500" },
  primary: {
    backgroundColor: "#1a6b4c",
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: "center",
    marginBottom: 34,
  },
  primaryDisabled: { backgroundColor: "#1d1f22" },
  primaryText: { color: "#ffffff", fontSize: 17, fontWeight: "700" },
  chargeBody: { flex: 1, alignItems: "center", justifyContent: "center", gap: 20 },
  chargeLabel: { color: "#8d9299", fontSize: 13, letterSpacing: 1 },
  chargeAmount: { color: "#e8e9ea", fontSize: 40, fontWeight: "700", letterSpacing: -1 },
  qrFrame: { backgroundColor: "#ffffff", padding: 18, borderRadius: 16 },
  chargeSub: { color: "#8d9299", fontSize: 14 },
  secondary: { marginTop: 12, paddingVertical: 14, paddingHorizontal: 40 },
  secondaryText: { color: "#8d9299", fontSize: 16 },
  secondaryCentred: { color: "#8d9299", fontSize: 15.5, textAlign: "center", lineHeight: 22 },
  debug: {
    marginTop: 22,
    borderTopWidth: 1,
    borderTopColor: "#282b2f",
    paddingTop: 12,
    width: "100%",
  },
  debugLabel: { color: "#5f646b", fontSize: 9.5, letterSpacing: 1.6, marginBottom: 3 },
  debugText: { color: "#8d9299", fontSize: 10.5, marginBottom: 10 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 24 },
  statusWaiting: { color: "#8d9299", fontSize: 14.5 },
  statusBad: { color: "#d4855e", fontSize: 14.5, textAlign: "center" },
  paidMark: { color: "#4fb98f", fontSize: 64 },
  paidTitle: { color: "#4fb98f", fontSize: 22, fontWeight: "700", letterSpacing: 1 },
  balanceBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: "#17191b",
    marginBottom: 8,
  },
  balanceLabel: { color: "#8d9299", fontSize: 11, letterSpacing: 2 },
  balanceValue: {
    color: "#e8e9ea",
    fontSize: 27,
    fontWeight: "700",
    letterSpacing: -0.6,
    marginTop: 3,
  },
  balanceAside: { alignItems: "flex-end" },
  balanceHeld: { color: "#4fb98f", fontSize: 14 },
  balanceNote: { color: "#8d9299", fontSize: 11.5, marginTop: 3 },
  todayBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: "#17191b",
  },
  todayLabel: { color: "#8d9299", fontSize: 13, letterSpacing: 1 },
  todayValue: { color: "#e8e9ea", fontSize: 16, fontWeight: "700" },
  todayCount: { color: "#8d9299", fontSize: 13, fontWeight: "400" },
  bookHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 18,
  },
  rebateRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: "#17191b",
    marginBottom: 22,
  },
  rebateLabel: { color: "#e8e9ea", fontSize: 15.5 },
  bookActions: { flexDirection: "row", gap: 18 },
  bookTitle: { color: "#e8e9ea", fontSize: 26, fontWeight: "700", letterSpacing: -0.6 },
  bookBody: { paddingBottom: 40 },
  empty: { color: "#8d9299", fontSize: 15.5, lineHeight: 24, marginTop: 28 },
  daySection: { marginBottom: 26 },
  dayHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  dayName: { color: "#e8e9ea", fontSize: 17, fontWeight: "700" },
  dayTotal: { color: "#4fb98f", fontSize: 17, fontWeight: "700" },
  dayCount: { color: "#8d9299", fontSize: 13, marginTop: 2, marginBottom: 8 },
  saleRow: {
    flexDirection: "row",
    alignItems: "baseline",
    paddingVertical: 11,
    borderTopWidth: 1,
    borderTopColor: "#282b2f",
    gap: 12,
  },
  saleTime: { color: "#8d9299", fontSize: 13.5, width: 46 },
  saleAmount: { color: "#e8e9ea", fontSize: 15.5, flex: 1 },
  saleToken: { color: "#8d9299", fontSize: 13 },
  offlineButton: {
    borderWidth: 1,
    borderColor: "#282b2f",
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 18,
  },
  offlineButtonText: { color: "#4fb98f", fontSize: 15 },
  owedBar: {
    marginTop: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: "#1f1a14",
  },
  owedText: { color: "#d4a15e", fontSize: 14.5, fontWeight: "600" },
  owedNote: { color: "#8d9299", fontSize: 13, marginTop: 4 },
});
