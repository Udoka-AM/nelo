/**
 * Close of day: what was sold, and what became of it.
 *
 * The day-book shows money that has arrived. Offline, goods go before the
 * money does, so this screen answers the question the day-book cannot: of
 * everything sold today, what is in, what is still coming, what needs a look,
 * and what is lost. The arithmetic is `reconcileDay` in `@nelo/ledger`, under
 * test; this only loads the two records and lays the answer out.
 */
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { dayLabel, formatTime, localDayKey, reconcileDay, type DayClose, type Sale, type Tally } from "@nelo/ledger";
import { standing } from "@nelo/queue";
import { formatLocalAmount, formatTokenAmount } from "@nelo/pay";
import { offlinePayments } from "./offline";

export interface CloseProps {
  sales: readonly Sale[];
  currency: { code: string; symbol: string; minorDigits: number };
  /** Minutes east of UTC. */
  tz: number;
  onDone: () => void;
}

const DAY_MS = 86_400_000;

export default function CloseOfDay({ sales, currency, tz, onDone }: CloseProps) {
  const [at, setAt] = useState(() => Date.now());
  const [close, setClose] = useState<DayClose | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const day = localDayKey(at, tz);
  const isToday = day === localDayKey(Date.now(), tz);

  const load = useCallback(async () => {
    try {
      const offline = (await offlinePayments()).map(({ entry, localMinor }) => {
        const s = standing(entry);
        return {
          id: entry.id,
          takenAt: entry.takenAt,
          localMinor,
          amountBaseUnits: entry.amount,
          state: s.state,
          why: s.state === "settled" ? null : s.why,
        };
      });
      setClose(reconcileDay(sales, offline, day, tz));
      setProblem(null);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Could not read the till's records.");
    }
  }, [sales, day, tz]);

  useEffect(() => {
    void load();
  }, [load]);

  const money = (t: Tally) => `${currency.symbol}${formatLocalAmount(t.localMinor, currency.minorDigits)}`;
  const count = (n: number) => `${n} ${n === 1 ? "sale" : "sales"}`;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Close of day</Text>
        <Pressable onPress={onDone} accessibilityRole="button">
          <Text style={styles.link}>Done</Text>
        </Pressable>
      </View>
      <View style={styles.dayNav}>
        <Pressable onPress={() => setAt(at - DAY_MS)} accessibilityRole="button" accessibilityLabel="Previous day">
          <Text style={styles.link}>‹</Text>
        </Pressable>
        <Text style={styles.dayName}>{dayLabel(day, Date.now(), tz)}</Text>
        <Pressable
          onPress={() => !isToday && setAt(at + DAY_MS)}
          disabled={isToday}
          accessibilityRole="button"
          accessibilityLabel="Next day"
        >
          <Text style={[styles.link, isToday && styles.faint]}>›</Text>
        </Pressable>
      </View>

      {problem ? <Text style={styles.note}>{problem}</Text> : null}
      {!close ? null : (
        <ScrollView contentContainerStyle={styles.body}>
          <Row label="Sold" value={money(close.sold)} sub={count(close.sold.count)} strong />

          <Row label="Received" value={money(close.received.total)} sub={count(close.received.total.count)} good />
          <Text style={styles.detail}>
            {money(close.received.online)} paid on the spot · {money(close.received.offline)} offline, settled
          </Text>

          {close.owed.count ? (
            <>
              <Row label="Still coming" value={money(close.owed)} sub={count(close.owed.count)} />
              <Text style={styles.detail}>Offline payments that arrive when you settle with signal.</Text>
            </>
          ) : null}

          {close.held.count ? (
            <>
              <Row label="Needs a look" value={money(close.held)} sub={count(close.held.count)} warn />
              {close.held.items.map((p) => (
                <Item key={p.id} time={formatTime(p.takenAt, tz)} amount={money({ ...p, count: 1 })} why={p.why} />
              ))}
            </>
          ) : null}

          {close.lost.count ? (
            <>
              <Row label="Lost" value={money(close.lost)} sub={count(close.lost.count)} bad />
              <Text style={styles.detail}>Goods handed over for payments that will not arrive.</Text>
              {close.lost.items.map((p) => (
                <Item key={p.id} time={formatTime(p.takenAt, tz)} amount={money({ ...p, count: 1 })} why={p.why} />
              ))}
            </>
          ) : null}

          {close.earlierOwed.count ? (
            <Text style={styles.note}>
              Also still coming from earlier days: {money(close.earlierOwed)}, {count(close.earlierOwed.count)}.
            </Text>
          ) : null}

          <View style={styles.check}>
            {close.mismatches.length === 0 ? (
              <Text style={styles.checkGood}>✓ The till's records agree.</Text>
            ) : (
              <Text style={styles.checkBad}>
                The till's records disagree on {count(close.mismatches.length)}. Settle again with signal, which
                usually fixes it. If it stays, report it: {close.mismatches.map((m) => m.id).join(", ")}.
              </Text>
            )}
          </View>
          <Text style={styles.faintNote}>
            {formatTokenAmount(close.received.total.amountBaseUnits)} USDC received for this day's sales.
          </Text>
        </ScrollView>
      )}
    </View>
  );
}

function Row(props: { label: string; value: string; sub: string; strong?: boolean; good?: boolean; warn?: boolean; bad?: boolean }) {
  const tone = props.good ? styles.good : props.warn ? styles.warn : props.bad ? styles.bad : styles.value;
  return (
    <View style={styles.row}>
      <View>
        <Text style={props.strong ? styles.labelStrong : styles.label}>{props.label}</Text>
        <Text style={styles.sub}>{props.sub}</Text>
      </View>
      <Text style={[tone, props.strong && styles.valueStrong]}>{props.value}</Text>
    </View>
  );
}

function Item(props: { time: string; amount: string; why?: string | null | undefined }) {
  return (
    <View style={styles.item}>
      <Text style={styles.itemLine}>
        {props.time} · {props.amount}
      </Text>
      {props.why ? <Text style={styles.itemWhy}>{props.why}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#101113", paddingTop: 64, paddingHorizontal: 20 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  title: { color: "#e8e9ea", fontSize: 26, fontWeight: "700", letterSpacing: -0.6 },
  link: { color: "#8d9299", fontSize: 16, paddingHorizontal: 8 },
  faint: { opacity: 0.3 },
  dayNav: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  dayName: { color: "#e8e9ea", fontSize: 17, fontWeight: "700" },
  body: { paddingBottom: 40, gap: 6 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#2a2c30",
  },
  label: { color: "#e8e9ea", fontSize: 16, fontWeight: "600" },
  labelStrong: { color: "#e8e9ea", fontSize: 18, fontWeight: "700" },
  sub: { color: "#8d9299", fontSize: 13, marginTop: 2 },
  value: { color: "#e8e9ea", fontSize: 17, fontWeight: "700" },
  valueStrong: { fontSize: 20 },
  good: { color: "#4fb98f", fontSize: 17, fontWeight: "700" },
  warn: { color: "#d4b85e", fontSize: 17, fontWeight: "700" },
  bad: { color: "#d4855e", fontSize: 17, fontWeight: "700" },
  detail: { color: "#8d9299", fontSize: 13.5, lineHeight: 20 },
  item: { paddingVertical: 6, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: "#2a2c30" },
  itemLine: { color: "#e8e9ea", fontSize: 14.5 },
  itemWhy: { color: "#8d9299", fontSize: 13, lineHeight: 19 },
  note: { color: "#8d9299", fontSize: 14, lineHeight: 21, marginTop: 14 },
  faintNote: { color: "#5d6269", fontSize: 12.5, marginTop: 10 },
  check: { marginTop: 22, paddingTop: 16, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#2a2c30" },
  checkGood: { color: "#4fb98f", fontSize: 14.5 },
  checkBad: { color: "#d4855e", fontSize: 14.5, lineHeight: 21 },
});
