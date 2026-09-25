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
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  Body,
  Button,
  Card,
  color,
  Field,
  Heading,
  Label,
  Muted,
  Notice,
  radius,
  Screen,
  space,
  Spinner,
  TextButton,
  Title,
  touch,
  type,
} from "@nelo/ui";
import {
  MARKETS,
  describeDestination,
  formatPhone,
  type Market,
  type Notice as OnboardNotice,
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
      <Screen center>
        <Spinner />
      </Screen>
    );
  }

  const busy = state.busy;
  const back = <TextButton label="‹ Back" onPress={() => dispatch({ type: "back" })} disabled={busy} accessibilityLabel="Go back" />;

  // ------------------------------------------------------------- market ---

  if (state.step === "market") {
    return (
      <Screen center>
        <Title>Where do you trade?</Title>
        <Muted>
          This sets how your phone number and your bank account are read. It cannot be worked out from the number
          itself — the same digits are a real number in more than one country.
        </Muted>
        {(Object.keys(MARKETS) as Market[]).map((market) => (
          <Card
            key={market}
            onPress={() => dispatch({ type: "choose-market", market })}
            accessibilityLabel={`${MARKET_NAMES[market]}, plus ${MARKETS[market].callingCode}`}
          >
            <View style={styles.choice}>
              <Heading>{MARKET_NAMES[market]}</Heading>
              <Muted>+{MARKETS[market].callingCode}</Muted>
            </View>
          </Card>
        ))}
        <TextButton label="I already have a wallet" onPress={onUseWallet} />
      </Screen>
    );
  }

  // -------------------------------------------------------------- phone ---

  if (state.step === "phone") {
    const rules = state.market ? MARKETS[state.market] : null;
    return (
      <Screen center>
        <View style={styles.back}>{back}</View>
        <Title>Your phone number</Title>
        <Muted>
          We text you a code to confirm it. This is also how you get back in if you change phones — there is no
          password and nothing to write down.
        </Muted>
        <Field
          label="Phone number"
          value={typed}
          onChangeText={setTyped}
          placeholder={rules?.example ?? ""}
          keyboardType="phone-pad"
          autoFocus
          editable={!busy}
        />
        <Message notice={state.notice} />
        <Button
          label={busy ? "Sending a code…" : "Send me a code"}
          busy={busy}
          disabled={typed.trim() === ""}
          onPress={() => dispatch({ type: "submit-phone", input: typed })}
        />
      </Screen>
    );
  }

  // --------------------------------------------------------------- code ---

  if (state.step === "code") {
    return (
      <Screen center>
        <View style={styles.back}>{back}</View>
        <Title>Type the code</Title>
        <Muted>Sent to {state.e164 ? formatPhone(state.e164) : "your phone"}.</Muted>
        <Field
          label="The code we texted you"
          value={code}
          onChangeText={setCode}
          placeholder="000000"
          keyboardType="number-pad"
          maxLength={8}
          autoFocus
          editable={!busy}
          style={styles.codeInput}
        />
        <Message notice={state.notice} />
        <Button
          label={busy ? "Checking…" : "Confirm"}
          busy={busy}
          disabled={code.trim() === ""}
          onPress={() => dispatch({ type: "submit-code", input: code })}
        />
        <TextButton label="Send it again" disabled={busy} onPress={() => dispatch({ type: "resend" })} />
      </Screen>
    );
  }

  // ------------------------------------------------------------- wallet ---

  if (state.step === "wallet") {
    return (
      <Screen center>
        {state.notice ? (
          <>
            <Message notice={state.notice} />
            <Button label="Try again" disabled={busy} onPress={() => dispatch({ type: "retry-wallet" })} />
          </>
        ) : (
          <Spinner label="Setting up your account…" />
        )}
      </Screen>
    );
  }

  // ------------------------------------------------------------- payout ---

  if (state.step === "payout") {
    const market = state.market;
    return (
      <Screen>
        <Title>Where should your money go?</Title>
        <Muted>Takings sit in your account until you cash out. This is the account they are paid into.</Muted>

        <View style={styles.tabs} accessibilityRole="tablist">
          {(["bank", "mobile_money"] as const).map((method) => (
            <Pressable
              key={method}
              style={[styles.tab, payoutMethod === method && styles.tabOn]}
              onPress={() => setPayoutMethod(method)}
              accessibilityRole="tab"
              accessibilityState={{ selected: payoutMethod === method }}
            >
              <Text style={payoutMethod === method ? styles.tabTextOn : styles.tabText}>
                {method === "bank" ? "Bank account" : "Mobile money"}
              </Text>
            </Pressable>
          ))}
        </View>

        {payoutMethod === "bank" ? (
          <>
            <Label>Bank</Label>
            {(market ? BANKS[market] : []).map((bank) => (
              <Card
                key={bank.code}
                selected={institution === bank.code}
                onPress={() => setInstitution(bank.code)}
                accessibilityLabel={bank.name}
              >
                <Body>{bank.name}</Body>
              </Card>
            ))}
            <Field
              label="Account number"
              value={account}
              onChangeText={setAccount}
              placeholder="10 digits"
              keyboardType="number-pad"
              editable={!busy}
            />
            <Message notice={state.notice} />
            <Button
              label="Save"
              busy={busy}
              disabled={institution === null || account.trim() === ""}
              onPress={() => dispatch({ type: "submit-bank", institution: institution ?? "", account })}
            />
          </>
        ) : (
          <>
            <Field
              label="Mobile money number"
              value={momo}
              onChangeText={setMomo}
              placeholder={market ? MARKETS[market].example : ""}
              keyboardType="phone-pad"
              editable={!busy}
            />
            <Message notice={state.notice} />
            <Button
              label="Save"
              busy={busy}
              disabled={momo.trim() === ""}
              onPress={() => dispatch({ type: "submit-mobile-money", phone: momo })}
            />
          </>
        )}
      </Screen>
    );
  }

  // --------------------------------------------------------------- done ---

  return (
    <Screen center>
      <Text style={styles.tick}>✓</Text>
      <Title center>Ready to take payments</Title>
      {state.destination ? <Muted center>Paid out to {describeDestination(state.destination)}</Muted> : null}
      {/* A check-digit mismatch is shown, never blocking: see nubanCheckDigit. */}
      {state.warnings.map((warning) => (
        <Notice key={warning} tone="caution">
          {warning}
        </Notice>
      ))}
      <Button
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
    </Screen>
  );
}

// ------------------------------------------------------------------ bits ---

/**
 * The audience split, on screen.
 *
 * A merchant's problem is theirs to fix and reads as an instruction. A
 * configuration problem is not theirs at all, so it is labelled as a setup
 * problem instead of implying they mistyped something — otherwise they retype
 * a perfectly good number until they give up.
 */
function Message({ notice }: { notice: OnboardNotice | null }) {
  if (!notice) return null;
  if (notice.audience === "merchant") return <Notice tone="danger">{notice.message}</Notice>;
  return <Notice tone="caution">{`Setup problem, not something you typed: ${notice.message}`}</Notice>;
}

const styles = StyleSheet.create({
  back: { alignSelf: "flex-start", marginLeft: -space.sm },
  choice: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  codeInput: { letterSpacing: 8, textAlign: "center", fontSize: type.title },
  tabs: { flexDirection: "row", gap: space.sm },
  tab: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: touch,
    borderRadius: radius.sm,
    backgroundColor: color.surface,
  },
  tabOn: { backgroundColor: color.primary },
  tabText: { color: color.textMuted, fontSize: type.small + 1 },
  tabTextOn: { color: color.onPrimary, fontSize: type.small + 1, fontWeight: "700" },
  tick: { color: color.positive, fontSize: 56, textAlign: "center" },
});
