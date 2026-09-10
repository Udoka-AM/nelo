/**
 * Nelo Merchant — the terminal.
 *
 * The merchant types an amount in their own currency and shows a code. The
 * customer pays with whatever wallet they already have; nothing here says the
 * word crypto, and nothing about the flow requires the customer to install
 * anything.
 *
 * Week 2 scope: amount entry, conversion, and the Solana Pay code. Mobile
 * Wallet Adapter onboarding, the day-book and payout come next — see
 * docs/DELIVERABLES.md.
 */
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import QRCode from "react-native-qrcode-svg";
import {
  encodeTransferRequest,
  formatLocalAmount,
  formatTokenAmount,
  localToTokenBaseUnits,
  type Rate,
} from "@nelo/pay";

// Placeholders until onboarding and the price feed land. The rate is a fixed
// quote, NOT a live feed — Pyth replaces this, and until it does every figure
// on screen is illustrative.
const MERCHANT_WALLET = "9EDhKVwHe5csswhp5PcY1DDwJRkfsrZKao7vsQPe7yrh";
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const CURRENCY = { code: "NGN", symbol: "₦", minorDigits: 2 };
const RATE: Rate = { localPerUsd: 165_025_000_000n, scale: 8, minorPerMajor: 100n };

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "·", "0", "⌫"];

export default function App() {
  // Held as minor units so no float ever touches a price.
  const [minor, setMinor] = useState(0n);
  const [charging, setCharging] = useState(false);

  const tokenAmount = useMemo(
    () => formatTokenAmount(localToTokenBaseUnits(minor, RATE)),
    [minor],
  );

  const url = useMemo(() => {
    if (minor === 0n) return null;
    return encodeTransferRequest({
      recipient: MERCHANT_WALLET,
      amount: tokenAmount,
      splToken: USDC_DEVNET,
      label: "Nelo",
      message: `${CURRENCY.symbol}${formatLocalAmount(minor, CURRENCY.minorDigits)}`,
    });
  }, [minor, tokenAmount]);

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
          <Pressable
            style={styles.secondary}
            onPress={() => setCharging(false)}
            accessibilityRole="button"
          >
            <Text style={styles.secondaryText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <View style={styles.amountBox}>
        <Text style={styles.currency}>{CURRENCY.code}</Text>
        <Text style={styles.amount} numberOfLines={1} adjustsFontSizeToFit>
          {CURRENCY.symbol}
          {formatLocalAmount(minor, CURRENCY.minorDigits)}
        </Text>
        <Text style={styles.converted}>
          {minor === 0n ? "Enter an amount" : `${tokenAmount} USDC`}
        </Text>
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
        style={[styles.primary, minor === 0n && styles.primaryDisabled]}
        disabled={minor === 0n}
        onPress={() => setCharging(true)}
        accessibilityRole="button"
      >
        <Text style={styles.primaryText}>Charge</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#101113", paddingTop: 64, paddingHorizontal: 20 },
  amountBox: { flex: 1, justifyContent: "center", alignItems: "center" },
  currency: { color: "#8d9299", fontSize: 12, letterSpacing: 2, marginBottom: 8 },
  amount: { color: "#e8e9ea", fontSize: 56, fontWeight: "700", letterSpacing: -1.5 },
  converted: { color: "#4fb98f", fontSize: 16, marginTop: 10 },
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
});
