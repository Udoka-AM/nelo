/**
 * The rebate election: cash or SKR, from next month.
 *
 * Cash is the default and is shown first. SKR is offered with its premium and
 * what it does for the offline limit, and with the price-risk notice, which
 * has to be accepted before SKR can be chosen. The rules are `@nelo/rebate`,
 * under test; this lays them out.
 *
 * Nothing here pays anything yet. Rebates accrue in `services/settle`, and
 * paying them out, in either form, is not built. The screen says so rather
 * than implying money is on its way.
 */
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { formatTokenAmount } from "@nelo/pay";
import type { Sale } from "@nelo/ledger";
import {
  choiceFor,
  DISCLOSURE,
  elect,
  formatMultiplier,
  fromJson,
  ILLUSTRATIVE_PREMIUM,
  monthOf,
  nextMonth,
  noElections,
  quote,
  type Choice,
  type Elections,
} from "@nelo/rebate";
import { loadSetting, saveSetting } from "./daybook";

const KEY = "rebate-elections";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (m: string) => MONTHS[Number(m.slice(5, 7)) - 1] ?? m;

export interface RebateProps {
  sales: readonly Sale[];
  /** Minutes east of UTC. */
  tz: number;
  onDone: () => void;
}

export default function Rebate({ sales, tz, onDone }: RebateProps) {
  const [elections, setElections] = useState<Elections | null>(null);
  const [picked, setPicked] = useState<Choice | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    loadSetting(KEY)
      .then((text) => setElections(fromJson(text)))
      .catch(() => setElections(noElections()));
  }, []);

  if (!elections) return <View style={styles.screen} />;

  const now = Date.now();
  const month = monthOf(now, tz);
  const volume = sales.filter((s) => monthOf(s.at, tz) === month).reduce((sum, s) => sum + s.amountBaseUnits, 0n);
  const q = quote(volume, ILLUSTRATIVE_PREMIUM);
  const thisMonth = choiceFor(elections, month);
  const nextChoice = choiceFor(elections, nextMonth(month));
  const choice = picked ?? nextChoice;
  const changed = choice !== nextChoice;

  async function save() {
    const r = elect(elections!, choice, { now: Date.now(), tzOffsetMinutes: tz, ...(accepted ? { acknowledged: DISCLOSURE.version } : {}) });
    if (!r.ok) {
      setNote(r.reason);
      return;
    }
    try {
      await saveSetting(KEY, JSON.stringify(r.elections));
      setElections(r.elections);
      setPicked(null);
      setAccepted(false);
      setNote(`Saved. From 1 ${monthName(r.from)}, your rebate comes as ${choice === "cash" ? "cash" : "SKR"}.`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not save your choice.");
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Your rebate</Text>
        <Pressable onPress={onDone} accessibilityRole="button">
          <Text style={styles.link}>Done</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.text}>
          Nelo gives back 0.1% of what you take. Choose how you get it. Your choice starts next month; {monthName(month)}{" "}
          stays {thisMonth === "cash" ? "cash" : "SKR"}.
        </Text>

        <Option
          selected={choice === "cash"}
          onPress={() => {
            setPicked("cash");
            setAccepted(false);
            setNote(null);
          }}
          title="Cash"
          badge="Default"
          amount={`$${formatTokenAmount(q.cash)} so far this month`}
          detail="Paid out with your takings."
        />
        <Option
          selected={choice === "skr"}
          onPress={() => {
            setPicked("skr");
            setNote(null);
          }}
          title={`SKR, ${formatMultiplier(q.premium.multiplierBps)} the cash rebate`}
          amount={`About $${formatTokenAmount(q.skrValue)} in SKR so far this month`}
          detail="Paid already staked. It raises your offline limit and earns staking yield."
          footnote={q.premium.illustrative ? `${formatMultiplier(q.premium.multiplierBps)} is an example, not yet a promise.` : null}
        />

        {choice === "skr" && changed ? (
          <View style={styles.disclosure}>
            <Text style={styles.disclosureText}>{DISCLOSURE.text}</Text>
            <Pressable
              style={styles.ack}
              onPress={() => setAccepted(!accepted)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: accepted }}
            >
              <Text style={styles.box}>{accepted ? "☑" : "☐"}</Text>
              <Text style={styles.ackText}>I understand, and I accept this risk.</Text>
            </Pressable>
          </View>
        ) : null}

        {changed ? (
          <Pressable
            style={[styles.primary, choice === "skr" && !accepted && styles.disabled]}
            disabled={choice === "skr" && !accepted}
            onPress={() => void save()}
            accessibilityRole="button"
          >
            <Text style={styles.primaryText}>Take it in {choice === "cash" ? "cash" : "SKR"} from next month</Text>
          </Pressable>
        ) : null}

        {note ? <Text style={styles.note}>{note}</Text> : null}
        <Text style={styles.faint}>Rebates are not paid out yet. This sets how they will be paid.</Text>
      </ScrollView>
    </View>
  );
}

function Option(props: {
  selected: boolean;
  onPress: () => void;
  title: string;
  badge?: string;
  amount: string;
  detail: string;
  footnote?: string | null;
}) {
  return (
    <Pressable
      style={[styles.option, props.selected && styles.optionSelected]}
      onPress={props.onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: props.selected }}
    >
      <View style={styles.optionHead}>
        <Text style={styles.optionTitle}>{props.title}</Text>
        {props.badge ? <Text style={styles.badge}>{props.badge}</Text> : null}
      </View>
      <Text style={styles.optionAmount}>{props.amount}</Text>
      <Text style={styles.optionDetail}>{props.detail}</Text>
      {props.footnote ? <Text style={styles.footnote}>{props.footnote}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#101113", paddingTop: 64, paddingHorizontal: 20 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  title: { color: "#e8e9ea", fontSize: 26, fontWeight: "700", letterSpacing: -0.6 },
  link: { color: "#8d9299", fontSize: 16, paddingHorizontal: 8 },
  body: { paddingBottom: 40, gap: 14 },
  text: { color: "#8d9299", fontSize: 15, lineHeight: 22 },
  option: { borderWidth: 1, borderColor: "#2a2c30", borderRadius: 14, padding: 16, gap: 4 },
  optionSelected: { borderColor: "#4fb98f", backgroundColor: "#132019" },
  optionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  optionTitle: { color: "#e8e9ea", fontSize: 17, fontWeight: "700", flexShrink: 1 },
  badge: { color: "#8d9299", fontSize: 12, borderWidth: 1, borderColor: "#2a2c30", borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 },
  optionAmount: { color: "#e8e9ea", fontSize: 15 },
  optionDetail: { color: "#8d9299", fontSize: 13.5, lineHeight: 20 },
  footnote: { color: "#d4b85e", fontSize: 12.5, marginTop: 4 },
  disclosure: { borderRadius: 14, padding: 16, backgroundColor: "#241a14", gap: 12 },
  disclosureText: { color: "#f0c9a8", fontSize: 15.5, lineHeight: 23, fontWeight: "600" },
  ack: { flexDirection: "row", alignItems: "center", gap: 10 },
  box: { color: "#f0c9a8", fontSize: 22 },
  ackText: { color: "#e8e9ea", fontSize: 15, flexShrink: 1 },
  primary: { backgroundColor: "#1a6b4c", borderRadius: 14, paddingVertical: 18, alignItems: "center" },
  disabled: { backgroundColor: "#1d1f22" },
  primaryText: { color: "#ffffff", fontSize: 16.5, fontWeight: "700" },
  note: { color: "#8d9299", fontSize: 14, lineHeight: 21 },
  faint: { color: "#5d6269", fontSize: 12.5, lineHeight: 18, marginTop: 8 },
});
