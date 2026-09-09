import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import { Banner, Button, Card, Empty, Field, Pill, SectionTitle, SummaryRow, SummaryTile } from '../components';
import DateNav from '../DateNav';
import { dueSoonCount, round1, SearchBox, shortDate, withinDays } from '../herd';
import { useNarrow, usePageStyle } from '../layout';
import { NumberCell, tableStyles } from '../tableCells';
import { colors, spacing } from '../theme';

// What the herd gave today.
//
// One of the two herd screens, and the one opened twice a day: somebody
// walks the shed with a phone and types what went into the can. Built as
// the day board's table is built, because it is read the same way — a
// row per animal, the two milkings typed straight into their cells, and
// a total line at the bottom.
//
// What is deliberately *not* here: the animals themselves. An animal's
// breed, where it came from and what it has been crossed with are facts
// about the animal, not about 8 September, and they used to sit behind
// an expander on this date-scoped page — which both misfiled them and
// hid them (Docs/DESIGN.md: a control that is hard to find is worse than
// one that is merely present). They live on HerdScreen now.
export default function MilkingScreen({ token, onScroll }) {
  const pageStyle = usePageStyle(860);
  const narrow = useNarrow();
  const [day, setDay] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [selectedDate, setSelectedDate] = useState('');
  const [search, setSearch] = useState('');
  const [busyCell, setBusyCell] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [nextDay, nextAlerts] = await Promise.all([
        api.getHerdDay(token, selectedDate || undefined),
        api.getHerdAlerts(token),
      ]);
      setDay(nextDay);
      setAlerts(nextAlerts.alerts || []);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token, selectedDate]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading) {
    return <ActivityIndicator style={styles.loader} color={colors.accent} />;
  }

  const animals = day?.animals || [];
  const yields = day?.yields || {};
  const due = day?.due || {};
  // What each animal normally gives, and whose milk must not go in the
  // churn today because she is under treatment.
  const averages = day?.averages || {};
  const withheld = day?.withheld || {};
  const date = day?.date;

  // Only what is being milked belongs on a milking sheet. A calf with
  // two empty cells beside it every day is two invitations to type a
  // mistake, and a sold animal is not on the farm at all.
  const milking = animals.filter((a) => a.active && a.stage === 'milking');
  const query = search.trim().toLowerCase();
  const shown = query
    ? milking.filter((a) => `${a.tag} ${a.name} ${a.breed}`.toLowerCase().includes(query))
    : milking;

  const soon = dueSoonCount(due, date);
  // Milk under a drug withdrawal was produced but cannot be sold, and a
  // total that blurs the two is the wrong number for both questions —
  // the row says "do not use" in red while its litres quietly joined the
  // day's figure. Every total on this screen is now sellable milk, and
  // what is being poured away is stated on its own.
  const sellable = milking.filter((a) => !withheld[a.id]);
  const totalMilk = sellable.reduce((sum, a) => {
    const y = yields[a.id];
    return sum + (y ? (Number(y.morning) || 0) + (Number(y.evening) || 0) : 0);
  }, 0);
  const discarded = milking.reduce((sum, a) => {
    if (!withheld[a.id]) {
      return sum;
    }
    const y = yields[a.id];
    return sum + (y ? (Number(y.morning) || 0) + (Number(y.evening) || 0) : 0);
  }, 0);

  const setSession = async (animal, session, raw) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      return;
    }
    setBusyCell(`${animal.id}:${session}`);
    setError('');
    try {
      await api.setMilkYield(token, animal.id, date, { [session]: value });
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyCell('');
    }
  };

  return (
    <ScrollView contentContainerStyle={pageStyle} onScroll={onScroll} scrollEventThrottle={16}>
      <Banner message={error} />

      {/* Raised by the milk itself, so it belongs on the screen where
          the milk is entered — an animal off its own average is worth
          seeing the same day, not the next time somebody opens the
          register. */}
      {alerts.length > 0 ? (
        <Banner tone="info" message={alerts.length === 1 ? 'Herd alert' : 'Herd alerts'} count={alerts.length}>
          <HerdAlerts alerts={alerts} token={token} onChanged={refresh} onError={setError} />
        </Banner>
      ) : null}

      <SummaryRow>
        <SummaryTile label="Milking" value={String(milking.length)} />
        {soon > 0 ? <SummaryTile label="Due within a month" value={String(soon)} tone="warning" /> : null}
        {totalMilk > 0 ? <SummaryTile label="Milk today" value={round1(totalMilk)} /> : null}
        {discarded > 0 ? (
          <SummaryTile label="Discarded" value={round1(discarded)} note="under treatment" tone="warning" />
        ) : null}
      </SummaryRow>

      <Card>
        <SectionTitle>Milking ({shown.length}{shown.length !== milking.length ? ` of ${milking.length}` : ''})</SectionTitle>
        <View style={styles.headingDivider} />

        <DateNav date={date} selectedDate={selectedDate} onSelect={setSelectedDate} />

        {milking.length === 0 ? (
          <Empty>Nothing is being milked. Animals and their stages live under Herd.</Empty>
        ) : (
          <>
            <View style={styles.toolsRow}>
              <SearchBox
                value={search}
                onChange={setSearch}
                label="Search the milking herd"
                placeholder="Tag, name, or breed"
              />
            </View>

            {shown.length === 0 ? (
              <Empty>Nothing matches that.</Empty>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.scroller}>
                <View>
                  <View style={[tableStyles.row, tableStyles.head, tableStyles.rule]}>
                    <Text style={[tableStyles.headCell, styles.tagColumn]}>Tag</Text>
                    <Text style={[tableStyles.headCell, styles.nameColumn, narrow && styles.nameColumnNarrow]}>
                      Name
                    </Text>
                    <Text style={[tableStyles.headCell, tableStyles.figure, styles.milkColumn]}>Morning</Text>
                    <Text style={[tableStyles.headCell, tableStyles.figure, styles.milkColumn]}>Evening</Text>
                    <Text style={[tableStyles.headCell, tableStyles.figure, styles.milkColumn]}>Total</Text>
                  </View>

                  {shown.map((animal) => {
                    const yield_ = yields[animal.id];
                    const morning = yield_ ? Number(yield_.morning) || 0 : null;
                    const evening = yield_ ? Number(yield_.evening) || 0 : null;
                    const total = (morning || 0) + (evening || 0);
                    const dueOn = due[animal.id];
                    const avg = averages[animal.id];
                    const hold = withheld[animal.id];
                    return (
                      <View key={animal.id} style={[tableStyles.row, tableStyles.rule]}>
                        <Text style={[styles.tagColumn, styles.tagText]} numberOfLines={1}>
                          {animal.tag}
                        </Text>
                        <View style={[styles.nameColumn, narrow && styles.nameColumnNarrow]}>
                          <Text style={styles.nameText} numberOfLines={1}>
                            {animal.name || '—'}
                          </Text>
                          {/* Milk under a withdrawal outranks a calving
                              date: one is a thing to plan for, the other
                              is a churn about to be contaminated. */}
                          {hold ? (
                            <Text style={styles.holdText} numberOfLines={1}>
                              ✕ do not use · {hold.reason || 'treated'} to {shortDate(hold.until)}
                            </Text>
                          ) : dueOn && withinDays(dueOn, date, 30) ? (
                            <Text style={styles.dueText}>due {shortDate(dueOn)}</Text>
                          ) : null}
                        </View>
                        <View style={styles.milkColumn}>
                          <NumberCell
                            value={morning === null ? '' : String(morning)}
                            empty="—"
                            width={68}
                            busy={busyCell === `${animal.id}:morning`}
                            ariaLabel={`Morning milk from ${animal.tag}`}
                            onCommit={(raw) => setSession(animal, 'morning', raw)}
                          />
                          <Shadow value={avg?.morning} />
                        </View>
                        <View style={styles.milkColumn}>
                          <NumberCell
                            value={evening === null ? '' : String(evening)}
                            empty="—"
                            width={68}
                            busy={busyCell === `${animal.id}:evening`}
                            ariaLabel={`Evening milk from ${animal.tag}`}
                            onCommit={(raw) => setSession(animal, 'evening', raw)}
                          />
                          <Shadow value={avg?.evening} />
                        </View>
                        <View style={styles.milkColumn}>
                          <Text style={[tableStyles.cell, tableStyles.figure, styles.totalCell]}>
                            {total > 0 ? round1(total) : '—'}
                          </Text>
                          <Shadow value={avg?.total} />
                        </View>
                      </View>
                    );
                  })}

                  {totalMilk > 0 ? (
                    <View style={[tableStyles.row, styles.totalsRow]}>
                      <Text style={[styles.tagColumn, styles.totalsLabel]}>
                        {discarded > 0 ? `${sellable.length} of ${milking.length}` : `${milking.length} milking`}
                      </Text>
                      <View style={[styles.nameColumn, narrow && styles.nameColumnNarrow]} />
                      {/* The herd's usual runs under the herd's today,
                          the same way each animal's does. */}
                      <View style={styles.milkColumn}>
                        <Text style={[tableStyles.cell, tableStyles.figure, styles.totalsFigure]}>
                          {round1(sumSession(sellable, yields, 'morning'))}
                        </Text>
                        <Shadow value={sumAverage(sellable, averages, 'morning')} />
                      </View>
                      <View style={styles.milkColumn}>
                        <Text style={[tableStyles.cell, tableStyles.figure, styles.totalsFigure]}>
                          {round1(sumSession(sellable, yields, 'evening'))}
                        </Text>
                        <Shadow value={sumAverage(sellable, averages, 'evening')} />
                      </View>
                      <View style={styles.milkColumn}>
                        <Text style={[tableStyles.cell, tableStyles.figure, styles.totalsFigure]}>
                          {round1(totalMilk)}
                        </Text>
                        <Shadow value={sumAverage(sellable, averages, 'total')} />
                      </View>
                    </View>
                  ) : null}
                </View>
              </ScrollView>
            )}
          </>
        )}
      </Card>
    </ScrollView>
  );
}

function sumSession(animals, yields, session) {
  return animals.reduce((sum, a) => sum + (Number(yields[a.id]?.[session]) || 0), 0);
}

// What the shed usually gives at this milking: every animal's own
// average added up. Not an average of averages — the question is "what
// does a normal morning put in the churn", and that is a sum.
function sumAverage(animals, averages, session) {
  return animals.reduce((sum, a) => sum + (Number(averages[a.id]?.[session]) || 0), 0);
}

// What she usually gives, under what she gave today.
//
// Faint on purpose. The figure somebody is typing is the subject of the
// screen; this is only here to answer "is that normal for her?" without
// anybody opening her record — and a second column of black numbers
// would compete with the first for the same glance (Docs/DESIGN.md,
// rule 2: ink is for differences).
//
// Absent rather than zero when there is no history: a new animal has no
// usual yet, and "0.0" would read as a fact about her.
function Shadow({ value }) {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return <Text style={styles.shadow}>{round1(value)}</Text>;
}

// The list inside the "Herd alerts" banner — one row per animal whose
// milk fell far enough below its own recent average to be worth a look.
// This app does not diagnose why; the note is where the farmer's own
// answer goes once they have checked the animal.
function HerdAlerts({ alerts, token, onChanged, onError }) {
  return (
    <View style={styles.alertsList}>
      {alerts.map((alert, index) => (
        <AlertRow
          key={alert.id}
          alert={alert}
          token={token}
          onChanged={onChanged}
          onError={onError}
          divide={index > 0}
        />
      ))}
    </View>
  );
}

function AlertRow({ alert, token, onChanged, onError, divide }) {
  const [note, setNote] = useState(alert.note || '');
  const [busy, setBusy] = useState('');

  const act = async (status) => {
    setBusy(status);
    try {
      await api.updateHerdAlert(token, alert.id, { status, note });
      await onChanged();
    } catch (err) {
      onError(err.message);
      setBusy('');
    }
  };

  return (
    <View style={[styles.alertRow, divide && styles.alertRowDivide]}>
      <View style={styles.alertHead}>
        <Text style={styles.alertHeadline}>
          {alert.animal_tag}: usually {round1(alert.baseline)}L a day, gave {round1(alert.actual)}L{' '}
          <Text style={styles.alertDrop}>(down {round1(alert.drop_pct)}%)</Text>
        </Text>
        {alert.status === 'acknowledged' ? <Pill label="Acknowledged" tone="neutral" /> : null}
      </View>
      <Field
        label="What did you find?"
        size="full"
        value={note}
        onChangeText={setNote}
        placeholder="e.g. off her feed, treated for mastitis, coming into heat"
      />
      <View style={styles.alertActions}>
        <Button
          title="Acknowledge"
          variant="secondary"
          busy={busy === 'acknowledged'}
          onPress={() => act('acknowledged')}
        />
        <Button title="Resolved" busy={busy === 'resolved'} onPress={() => act('resolved')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  loader: { marginTop: spacing.xl * 2 },
  alertsList: { gap: spacing.md },
  alertRow: { gap: spacing.xs },
  alertRowDivide: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.md,
    marginTop: spacing.xs,
  },
  alertHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  alertHeadline: { fontSize: 14, color: colors.text, flexShrink: 1 },
  alertDrop: { fontWeight: '700', color: colors.warning },
  alertActions: { flexDirection: 'row', gap: spacing.sm },

  headingDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginTop: -spacing.sm,
    marginBottom: spacing.md,
  },
  toolsRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },

  scroller: { flexGrow: 1 },
  tagColumn: { width: 78, paddingHorizontal: spacing.xs },
  tagText: { fontSize: 15, fontWeight: '800', color: colors.text, fontVariant: ['tabular-nums'] },
  nameColumn: { width: 170, paddingHorizontal: spacing.xs, minWidth: 0 },
  nameColumnNarrow: { width: 110 },
  nameText: { fontSize: 14, fontWeight: '600', color: colors.text },
  dueText: { fontSize: 11, fontWeight: '700', color: colors.warning, marginTop: 1 },
  holdText: { fontSize: 11, fontWeight: '700', color: colors.error, marginTop: 1 },
  // The shadow figure: her usual, under today's. Small and pale enough
  // to read only when looked for.
  shadow: {
    fontSize: 11,
    color: colors.hint,
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  milkColumn: { width: 84, alignItems: 'flex-end', paddingHorizontal: spacing.xs, justifyContent: 'center' },
  totalCell: { fontWeight: '700', color: colors.text },
  totalsRow: {
    borderTopWidth: 2,
    borderTopColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    paddingVertical: spacing.xs,
  },
  totalsLabel: { fontSize: 12, fontWeight: '700', color: colors.subtitle },
  totalsFigure: { fontSize: 14, fontWeight: '800', color: colors.text },
});
