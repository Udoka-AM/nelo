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
import { StyleSheet, View } from "react-native";
import { color, Divider, Figure, Header, Heading, Muted, Notice, Row, Screen, Small, space, TextButton } from "@nelo/ui";
import { dayLabel, formatTime, localDayKey, reconcileDay, type DayClose, type Sale } from "@nelo/ledger";
import { standing } from "@nelo/queue";
import { formatDollars, formatMoney } from "@nelo/pay";
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

  const money = (t: { localMinor: bigint }) => formatMoney(t.localMinor, currency);
  const count = (n: number) => `${n} ${n === 1 ? "sale" : "sales"}`;
  /** A short code a merchant can read out over the phone, not a vault address. */
  const code = (id: string) => {
    const [vault = "", seq = ""] = id.split(":");
    return `${vault.slice(0, 6)}-${seq}`;
  };

  return (
    <Screen>
      <Header title="Close of day" actions={[{ label: "Done", onPress: onDone }]} />
      <View style={styles.dayNav}>
        <TextButton label="‹" onPress={() => setAt(at - DAY_MS)} accessibilityLabel="Previous day" />
        <Heading>{dayLabel(day, Date.now(), tz)}</Heading>
        <TextButton label="›" onPress={() => setAt(at + DAY_MS)} disabled={isToday} accessibilityLabel="Next day" />
      </View>

      {problem ? <Notice tone="danger">{problem}</Notice> : null}
      {!close ? null : (
        <>
          <Row label="Sold" value={money(close.sold)} sub={count(close.sold.count)} strong />
          <Divider />
          <Row label="Received" value={money(close.received.total)} sub={count(close.received.total.count)} tone="positive" />
          <Small>
            {money(close.received.online)} paid on the spot · {money(close.received.offline)} offline, settled
          </Small>

          {close.owed.count ? (
            <>
              <Divider />
              <Row label="Still coming" value={money(close.owed)} sub={count(close.owed.count)} tone="caution" />
              <Small>Offline payments that arrive when you settle with signal.</Small>
            </>
          ) : null}

          {close.held.count ? (
            <>
              <Divider />
              <Row label="Needs a look" value={money(close.held)} sub={count(close.held.count)} tone="caution" />
              {close.held.items.map((p) => (
                <Item key={p.id} time={formatTime(p.takenAt, tz)} amount={money(p)} why={p.why} />
              ))}
            </>
          ) : null}

          {close.lost.count ? (
            <>
              <Divider />
              <Row label="Lost" value={money(close.lost)} sub={count(close.lost.count)} tone="danger" />
              <Small>Goods handed over for payments that will not arrive.</Small>
              {close.lost.items.map((p) => (
                <Item key={p.id} time={formatTime(p.takenAt, tz)} amount={money(p)} why={p.why} />
              ))}
            </>
          ) : null}

          {close.earlierOwed.count ? (
            <Muted>
              Also still coming from earlier days: {money(close.earlierOwed)}, {count(close.earlierOwed.count)}.
            </Muted>
          ) : null}

          {close.mismatches.length === 0 ? (
            <Notice tone="positive">✓ The till's records agree.</Notice>
          ) : (
            <Notice tone="caution">
              The till's records disagree on {count(close.mismatches.length)}. Settling again with signal usually fixes
              it. If it stays, tell Nelo: {close.mismatches.map((m) => code(m.id)).join(", ")}.
            </Notice>
          )}
          <Small>{formatDollars(close.received.total.amountBaseUnits)} received in US dollars for this day's sales.</Small>
        </>
      )}
    </Screen>
  );
}

function Item(props: { time: string; amount: string; why?: string | null | undefined }) {
  return (
    <View style={styles.item} accessible accessibilityLabel={`${props.time}, ${props.amount}${props.why ? `. ${props.why}` : ""}`}>
      <Figure>
        {props.time} · {props.amount}
      </Figure>
      {props.why ? <Small>{props.why}</Small> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  dayNav: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  item: { paddingVertical: space.sm, paddingLeft: space.md, borderLeftWidth: 2, borderLeftColor: color.border, gap: 2 },
});
