/**
 * Onboarding, on screen.
 *
 * Six steps, each one screen, each asking for one thing. The order and the
 * rules are `@nelo/onboard`'s `flow.ts`; this file renders whatever step that
 * says the merchant is on and dispatches what they did. It holds no rules of
 * its own, deliberately — the point of the machine is that the logic is tested
 * somewhere a handset is not required.
 *
 * The bank list is the one thing here that is knowingly provisional: it is a
 * handful of institution codes, not the published register. See BANKS.
 */
import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  MARKETS,
  describeDestination,
  formatPhone,
  type Market,
  type Notice,
} from "@nelo/onboard";
import { useOnboarding } from "./privy";
import type { MerchantAccount } from "./account";

/**
 * Enough to demonstrate the flow, and **not** the published register.
 *
 * Nigeria's list is the CBN's; the Philippines' is whatever the payout partner
 * supports. Both belong in a file fetched at runtime, because a bank code
 * baked into an APK is a bank code that cannot be corrected without a release.
 * Until there is a partner to fetch them from, these are hard-coded and
 * labelled as such rather than quietly presented as complete.
 */
const BANKS: Record<Market, { code: string; name: string }[]> = {
  NG: [
    { code: "058", name: "Guaranty Trust Bank" },
    { code: "011", name: "First Bank" },
    { code: "044", name: "Access Bank" },
    { code: "057", name: "Zenith Bank" },
    { code: "033", name: "United Bank for Africa" },
    { code: "232", name: "Sterling Bank" },
    { code: "050", name: "Ecobank" },
    { code: "221", name: "Stanbic IBTC" },
  ],
  PH: [
    { code: "BDO", name: "BDO Unibank" },
    { code: "BPI", name: "Bank of the Philippine Islands" },
    { code: "MBT", name: "Metrobank" },
    { code: "LBP", name: "Land Bank of the Philippines" },
  ],
};

const MARKET_NAMES: Record<Market, string> = { NG: "Nigeria", PH: "Philippines" };

interface Props {
  /** Called once, with everything the till needs to start trading. */
  onComplete: (account: MerchantAccount) => void;
  /** "I already have a wallet" — hands back to Mobile Wallet Adapter. */
  onUseWallet: () => void;
}

export default function Onboarding({ onComplete, onUseWallet }: Props) {
  const { state, ready, dispatch } = useOnboarding();
  const [typed, setTyped] = useState("");
  const [code, setCode] = useState("");
  const [institution, setInstitution] = useState<string | null>(null);
  const [account, setAccount] = useState("");
  const [momo, setMomo] = useState("");
  const [payoutMethod, setPayoutMethod] = useState<"bank" | "mobile_money">("bank");

  if (!ready) {
    return (
      <View style={[styles.body, styles.centre]}>
        <ActivityIndicator color="#4fb98f" />
      </View>
    );
  }

  const busy = state.busy;

  // ------------------------------------------------------------- market ---

  if (state.step === "market") {
    return (
      <View style={styles.body}>
        <Text style={styles.title}>Where do you trade?</Text>
        <Text style={styles.blurb}>
          This sets how your phone number and your bank account are read. It cannot be
          worked out from the number itself — the same digits are a real number in more
          than one country.
        </Text>
        {(Object.keys(MARKETS) as Market[]).map((market) => (
          <Pressable
            key={market}
            style={styles.choice}
            onPress={() => dispatch({ type: "choose-market", market })}
            accessibilityRole="button"
          >
            <Text style={styles.choiceText}>{MARKET_NAMES[market]}</Text>
            <Text style={styles.choiceAside}>+{MARKETS[market].callingCode}</Text>
          </Pressable>
        ))}
        <Pressable style={styles.link} onPress={onUseWallet} accessibilityRole="button">
          <Text style={styles.linkText}>I already have a wallet</Text>
        </Pressable>
      </View>
    );
  }

  // -------------------------------------------------------------- phone ---

  if (state.step === "phone") {
    const rules = state.market ? MARKETS[state.market] : null;
    return (
      <View style={styles.body}>
        <Back onPress={() => dispatch({ type: "back" })} disabled={busy} />
        <Text style={styles.title}>Your phone number</Text>
        <Text style={styles.blurb}>
          We text you a code to confirm it. This is also how you get back in if you
          change phones — there is no password and nothing to write down.
        </Text>
        <TextInput
          style={styles.input}
          value={typed}
          onChangeText={setTyped}
          placeholder={rules?.example ?? ""}
          placeholderTextColor="#5b6066"
          keyboardType="phone-pad"
          autoFocus
          editable={!busy}
          accessibilityLabel="Phone number"
        />
        <Message notice={state.notice} />
        <Primary
          label={busy ? "Sending a code…" : "Send me a code"}
          disabled={busy || typed.trim() === ""}
          onPress={() => dispatch({ type: "submit-phone", input: typed })}
        />
      </View>
    );
  }

  // --------------------------------------------------------------- code ---

  if (state.step === "code") {
    return (
      <View style={styles.body}>
        <Back onPress={() => dispatch({ type: "back" })} disabled={busy} />
        <Text style={styles.title}>Type the code</Text>
        <Text style={styles.blurb}>
          Sent to {state.e164 ? formatPhone(state.e164) : "your phone"}.
        </Text>
        <TextInput
          style={[styles.input, styles.codeInput]}
          value={code}
          onChangeText={setCode}
          placeholder="000000"
          placeholderTextColor="#5b6066"
          keyboardType="number-pad"
          maxLength={8}
          autoFocus
          editable={!busy}
          accessibilityLabel="The code we texted you"
        />
        <Message notice={state.notice} />
        <Primary
          label={busy ? "Checking…" : "Confirm"}
          disabled={busy || code.trim() === ""}
          onPress={() => dispatch({ type: "submit-code", input: code })}
        />
        <Pressable
          style={styles.link}
          disabled={busy}
          onPress={() => dispatch({ type: "resend" })}
          accessibilityRole="button"
        >
          <Text style={styles.linkText}>Send it again</Text>
        </Pressable>
      </View>
    );
  }

  // ------------------------------------------------------------- wallet ---

  if (state.step === "wallet") {
    return (
      <View style={[styles.body, styles.centre]}>
        {state.notice ? (
          <>
            <Message notice={state.notice} />
            <Primary
              label="Try again"
              disabled={busy}
              onPress={() => dispatch({ type: "retry-wallet" })}
            />
          </>
        ) : (
          <>
            <ActivityIndicator color="#4fb98f" />
            <Text style={styles.blurb}>Setting up your account…</Text>
          </>
        )}
      </View>
    );
  }

  // ------------------------------------------------------------- payout ---

  if (state.step === "payout") {
    const market = state.market;
    return (
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.title}>Where should your money go?</Text>
        <Text style={styles.blurb}>
          Takings sit in your account until you cash out. This is the account they are
          paid into.
        </Text>

        <View style={styles.tabs}>
          {(["bank", "mobile_money"] as const).map((method) => (
            <Pressable
              key={method}
              style={[styles.tab, payoutMethod === method && styles.tabOn]}
              onPress={() => setPayoutMethod(method)}
              accessibilityRole="button"
            >
              <Text style={payoutMethod === method ? styles.tabTextOn : styles.tabText}>
                {method === "bank" ? "Bank account" : "Mobile money"}
              </Text>
            </Pressable>
          ))}
        </View>

        {payoutMethod === "bank" ? (
          <>
            <View style={styles.bankList}>
              {(market ? BANKS[market] : []).map((bank) => (
                <Pressable
                  key={bank.code}
                  style={[styles.bank, institution === bank.code && styles.bankOn]}
                  onPress={() => setInstitution(bank.code)}
                  accessibilityRole="button"
                >
                  <Text style={styles.bankText}>{bank.name}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              style={styles.input}
              value={account}
              onChangeText={setAccount}
              placeholder="Account number"
              placeholderTextColor="#5b6066"
              keyboardType="number-pad"
              editable={!busy}
              accessibilityLabel="Account number"
            />
            <Message notice={state.notice} />
            <Primary
              label="Save"
              disabled={busy || institution === null || account.trim() === ""}
              onPress={() =>
                dispatch({
                  type: "submit-bank",
                  institution: institution ?? "",
                  account,
                })
              }
            />
          </>
        ) : (
          <>
            <TextInput
              style={styles.input}
              value={momo}
              onChangeText={setMomo}
              placeholder={market ? MARKETS[market].example : ""}
              placeholderTextColor="#5b6066"
              keyboardType="phone-pad"
              editable={!busy}
              accessibilityLabel="Mobile money number"
            />
            <Message notice={state.notice} />
            <Primary
              label="Save"
              disabled={busy || momo.trim() === ""}
              onPress={() => dispatch({ type: "submit-mobile-money", phone: momo })}
            />
          </>
        )}
      </ScrollView>
    );
  }

  // --------------------------------------------------------------- done ---

  return (
    <View style={[styles.body, styles.centre]}>
      <Text style={styles.tick}>✓</Text>
      <Text style={styles.title}>Ready to take payments</Text>
      {state.destination ? (
        <Text style={styles.blurb}>Paid out to {describeDestination(state.destination)}</Text>
      ) : null}
      {/* A check-digit mismatch is shown, never blocking: see nubanCheckDigit. */}
      {state.warnings.map((warning) => (
        <Text key={warning} style={styles.warn}>
          {warning}
        </Text>
      ))}
      <Primary
        label="Start"
        disabled={state.address === null}
        onPress={() => {
          if (state.address === null) return;
          onComplete({
            kind: "embedded",
            address: state.address,
            ...(state.e164 ? { label: formatPhone(state.e164) } : {}),
            ...(state.canonical ? { payout: state.canonical } : {}),
          });
        }}
      />
    </View>
  );
}

// ------------------------------------------------------------------ bits ---

function Primary({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.primary, disabled && styles.primaryOff]}
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
    >
      <Text style={styles.primaryText}>{label}</Text>
    </Pressable>
  );
}

function Back({ onPress, disabled }: { onPress: () => void; disabled: boolean }) {
  return (
    <Pressable
      style={styles.back}
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Go back"
    >
      <Text style={styles.linkText}>‹ Back</Text>
    </Pressable>
  );
}

/**
 * The audience split, on screen.
 *
 * A merchant's problem is theirs to fix and reads as an instruction. A
 * configuration problem is not theirs at all, so it is labelled as a setup
 * problem instead of implying they mistyped something — otherwise they retype
 * a perfectly good number until they give up.
 */
function Message({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  if (notice.audience === "merchant") {
    return <Text style={styles.warn}>{notice.message}</Text>;
  }
  return (
    <View style={styles.setupBox}>
      <Text style={styles.setupLabel}>SETUP PROBLEM</Text>
      <Text style={styles.setupText}>{notice.message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flexGrow: 1, justifyContent: "center", gap: 14, paddingBottom: 30 },
  centre: { alignItems: "center" },
  title: { color: "#e8e9ea", fontSize: 28, fontWeight: "700", letterSpacing: -0.7 },
  blurb: { color: "#8d9299", fontSize: 16, lineHeight: 24, textAlign: "center" },
  input: {
    backgroundColor: "#17191b",
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 16,
    color: "#e8e9ea",
    fontSize: 20,
  },
  codeInput: { letterSpacing: 8, textAlign: "center", fontSize: 26 },
  choice: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "#17191b",
    borderRadius: 12,
    paddingVertical: 18,
    paddingHorizontal: 16,
  },
  choiceText: { color: "#e8e9ea", fontSize: 17, fontWeight: "600" },
  choiceAside: { color: "#8d9299", fontSize: 15 },
  primary: {
    backgroundColor: "#1a6b4c",
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: "center",
    alignSelf: "stretch",
  },
  primaryOff: { backgroundColor: "#1d1f22" },
  primaryText: { color: "#ffffff", fontSize: 17, fontWeight: "700" },
  link: { alignItems: "center", paddingVertical: 12 },
  linkText: { color: "#8d9299", fontSize: 15.5 },
  back: { alignSelf: "flex-start", paddingVertical: 6 },
  warn: { color: "#d4855e", fontSize: 14.5, lineHeight: 21, textAlign: "center" },
  setupBox: {
    backgroundColor: "#241c17",
    borderRadius: 12,
    padding: 14,
    gap: 6,
  },
  setupLabel: { color: "#d4855e", fontSize: 10.5, letterSpacing: 2, fontWeight: "700" },
  setupText: { color: "#c8a68f", fontSize: 14, lineHeight: 21 },
  tabs: { flexDirection: "row", gap: 8 },
  tab: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: "#17191b",
  },
  tabOn: { backgroundColor: "#1a6b4c" },
  tabText: { color: "#8d9299", fontSize: 14.5 },
  tabTextOn: { color: "#ffffff", fontSize: 14.5, fontWeight: "700" },
  bankList: { gap: 6 },
  bank: { backgroundColor: "#17191b", borderRadius: 10, paddingVertical: 13, paddingHorizontal: 14 },
  bankOn: { backgroundColor: "#224034" },
  bankText: { color: "#e8e9ea", fontSize: 15.5 },
  tick: { color: "#4fb98f", fontSize: 56 },
});
