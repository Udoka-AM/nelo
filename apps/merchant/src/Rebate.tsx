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
import { Pressable, StyleSheet, Text, View } from "react-native";
import { formatDollars } from "@nelo/pay";
import { Body, Button, Card, color, Header, Heading, Muted, Notice, radius, Screen, Small, space, Spinner, touch, type } from "@nelo/ui";
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

  if (!elections) return <Screen center><Spinner /></Screen>;

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
    <Screen>
      <Header title="Your rebate" actions={[{ label: "Done", onPress: onDone }]} />
      <Muted>
        Nelo gives back 0.1% of what you take. Choose how you get it. Your choice starts next month; {monthName(month)} stays{" "}
        {thisMonth === "cash" ? "cash" : "SKR"}.
      </Muted>

      <Option
        selected={choice === "cash"}
        onPress={() => {
          setPicked("cash");
          setAccepted(false);
          setNote(null);
        }}
        title="Cash"
        badge="Default"
        amount={`${formatDollars(q.cash)} so far this month`}
        detail="Paid out with your takings."
      />
      <Option
        selected={choice === "skr"}
        onPress={() => {
          setPicked("skr");
          setNote(null);
        }}
        title={`SKR, ${formatMultiplier(q.premium.multiplierBps)} the cash rebate`}
        amount={`About ${formatDollars(q.skrValue)} in SKR so far this month`}
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
            accessibilityLabel="I understand, and I accept this risk"
          >
            <View style={[styles.box, accepted && styles.boxOn]}>{accepted ? <Text style={styles.tick}>✓</Text> : null}</View>
            <Body style={{ flexShrink: 1 }}>I understand, and I accept this risk.</Body>
          </Pressable>
        </View>
      ) : null}

      {changed ? (
        <Button
          label={`Take it in ${choice === "cash" ? "cash" : "SKR"} from next month`}
          disabled={choice === "skr" && !accepted}
          onPress={() => void save()}
        />
      ) : null}

      {note ? <Notice tone="positive">{note}</Notice> : null}
      <Small>Rebates are not paid out yet. This sets how they will be paid.</Small>
    </Screen>
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
    <Card selected={props.selected} onPress={props.onPress} accessibilityLabel={`${props.title}. ${props.amount}`}>
      <View style={styles.optionHead}>
        <Heading style={{ flexShrink: 1 }}>{props.title}</Heading>
        {props.badge ? <Text style={styles.badge}>{props.badge}</Text> : null}
      </View>
      <Body>{props.amount}</Body>
      <Small>{props.detail}</Small>
      {props.footnote ? <Small tone="caution">{props.footnote}</Small> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  optionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.sm },
  badge: {
    color: color.textMuted,
    fontSize: type.caption,
    borderWidth: 1,
    borderColor: color.borderStrong,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  disclosure: { borderRadius: radius.md, padding: space.lg, backgroundColor: color.cautionSurface, gap: space.md },
  disclosureText: { color: color.caution, fontSize: type.body + 1, lineHeight: 25, fontWeight: "700" },
  ack: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: touch },
  box: { width: 28, height: 28, borderRadius: 6, borderWidth: 2, borderColor: color.caution, alignItems: "center", justifyContent: "center" },
  boxOn: { backgroundColor: color.caution },
  tick: { color: color.bg, fontSize: 18, fontWeight: "700" },
});
