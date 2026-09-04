import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import * as api from './api';
import { colors, radius, spacing } from './theme';

// What this customer has coming, and what they have had.
//
// Every other screen is organised by day, which is right for running a
// round and wrong for answering a question about a person. Two questions
// in particular have had no answer anywhere in the app:
//
//   "What have we already promised them?" A one-off booked a fortnight
//   ago is invisible until the morning it turns up on the round, by
//   which point the milk either exists or it does not. Extras are how a
//   dairy gets caught short, so they are the thing worth showing early —
//   and a booking you can see is a booking you can still change.
//
//   "What have they actually been getting?" Which is the question behind
//   every billing argument, and behind "are they still worth the stop?".
//
// Only what is *not* the standing order is worth listing forward:
// tomorrow's ordinary two litres is already described, in one line, by
// the standing order above. An extra, a changed number, a skip — those
// are the surprises.

const NEVER_MIND = { back: 60, ahead: 30 };

export default function CustomerTimeline({ token, customer, todayDate, onError, onChanged }) {
  const [state, setState] = useState({ loading: true, orders: [] });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api.customerOrders(token, customer.id, NEVER_MIND);
      setState({ loading: false, orders: data.orders || [] });
    } catch (err) {
      setState({ loading: false, orders: [] });
      if (onError) {
        onError(err.message);
      }
    }
  }, [token, customer.id, onError]);

  useEffect(() => {
    load();
  }, [load]);

  const today = todayDate || '';
  // Dates are ISO strings, so comparing them as strings compares them as
  // dates — the same thing the store relies on.
  const upcoming = state.orders
    .filter((o) => o.special && o.delivery_date > today)
    .sort((a, b) => a.delivery_date.localeCompare(b.delivery_date));
  const past = state.orders.filter((o) => o.delivery_date < today);

  // Calling off a booked extra. Skipping rather than deleting, because
  // the round may already be built around it and a stop that vanishes is
  // harder to explain to a driver than one marked "not today".
  const cancel = async (order) => {
    setBusyId(order.id);
    try {
      await api.overrideOrder(token, order.id, { status: 'skipped', reason: 'called off' });
      await load();
      if (onChanged) {
        await onChanged();
      }
    } catch (err) {
      if (onError) {
        onError(err.message);
      }
    } finally {
      setBusyId(null);
    }
  };

  if (state.loading) {
    return <ActivityIndicator style={styles.loader} />;
  }

  return (
    <View style={styles.wrap}>
      {upcoming.length > 0 ? (
        <View style={styles.block}>
          <Text style={styles.heading}>Coming up</Text>
          {upcoming.map((order) => (
            <View key={order.id} style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.when}>{longDate(order.delivery_date, today)}</Text>
                <Text style={styles.what}>
                  {describe(order)}
                  {order.note ? ` · ${order.note}` : ''}
                </Text>
              </View>
              {order.status === 'skipped' ? (
                <Text style={styles.calledOff}>called off</Text>
              ) : (
                <Pressable
                  onPress={() => cancel(order)}
                  disabled={busyId === order.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Call off ${describe(order)} on ${order.delivery_date}`}
                  style={({ pressed }) => [styles.callOff, pressed && styles.pressed]}
                >
                  <Text style={styles.callOffText}>{busyId === order.id ? '…' : 'Call off'}</Text>
                </Pressable>
              )}
            </View>
          ))}
          <Text style={styles.note}>
            Extras and changes only — what they normally take is the standing order above.
          </Text>
        </View>
      ) : null}

      {/* History is behind a press because it is the rare question. An
          admin opens a customer to change something far more often than
          to audit them, and a list of every delivery since spring would
          bury the controls they came for. */}
      <Pressable
        onPress={() => setHistoryOpen((prev) => !prev)}
        accessibilityRole="button"
        accessibilityState={{ expanded: historyOpen }}
        style={({ pressed }) => [styles.historyToggle, pressed && styles.pressed]}
      >
        {/* The ⋯ this app uses everywhere for the rare thing. Kept next
            to its own words rather than up in the card's title: an
            unlabelled ⋯ is a door with nothing written on it, and the
            count is the reason to open it. */}
        <Text style={styles.dots}>⋯</Text>
        <Text style={styles.historyToggleText}>
          {historyOpen ? 'Hide order history' : `Order history${past.length ? ` (${past.length})` : ''}`}
        </Text>
      </Pressable>

      {historyOpen ? (
        past.length === 0 ? (
          <Text style={styles.empty}>
            Nothing delivered yet. History fills in from the first round they are on.
          </Text>
        ) : (
          <View style={styles.block}>
            {past.map((order) => (
              <View key={order.id} style={styles.historyRow}>
                <Text style={styles.historyWhen}>{shortDate(order.delivery_date)}</Text>
                <Text style={styles.historyWhat}>{describe(order)}</Text>
                {/* A failed delivery is the only line here anybody is
                    looking for. Green on the ones that went fine and
                    grey on the one that did not had it hiding in plain
                    sight. */}
                <Text
                  style={[
                    styles.status,
                    order.status === 'delivered' && styles.statusDone,
                    (order.status === 'failed' || order.status === 'skipped') && styles.statusOff,
                  ]}
                >
                  {order.status}
                </Text>
              </View>
            ))}
          </View>
        )
      ) : null}
    </View>
  );
}

function describe(order) {
  const name = order.product_name || 'item';
  // A skip zeroes the quantity, so printing it would say "0 × Milk 1L",
  // which is a number about nothing. The product alone is the honest
  // description of a delivery that is not happening.
  return order.status === 'skipped' ? name : `${order.quantity} × ${name}`;
}

// "Tomorrow" and "Thursday" are how somebody thinks about the next few
// days; past about a week the day name stops locating anything and the
// date has to say it.
function longDate(iso, today) {
  const day = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(day.getTime())) {
    return iso;
  }
  const now = new Date(`${today}T00:00:00`);
  const days = Math.round((day - now) / 86400000);
  if (days === 1) {
    return 'Tomorrow';
  }
  if (days > 1 && days < 7) {
    return day.toLocaleDateString(undefined, { weekday: 'long' });
  }
  return day.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function shortDate(iso) {
  const day = new Date(`${iso}T00:00:00`);
  return Number.isNaN(day.getTime()) ? iso : day.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.sm },
  loader: { marginVertical: spacing.md },
  block: { marginBottom: spacing.sm },
  heading: { fontSize: 13, fontWeight: '700', color: colors.label, marginBottom: spacing.xs },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    marginBottom: 4,
  },
  rowText: { flexShrink: 1 },
  when: { fontSize: 13, fontWeight: '700', color: colors.text },
  what: { fontSize: 13, color: colors.subtitle, marginTop: 1 },
  callOff: { paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: 999, backgroundColor: colors.surfaceAlt },
  callOffText: { fontSize: 12, fontWeight: '700', color: colors.link },
  calledOff: { fontSize: 12, color: colors.hint, fontStyle: 'italic' },
  pressed: { opacity: 0.6 },
  note: { fontSize: 12, color: colors.hint, lineHeight: 16 },
  historyToggle: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingVertical: spacing.xs },
  historyToggleText: { fontSize: 13, fontWeight: '600', color: colors.link },
  dots: { fontSize: 15, fontWeight: '700', color: colors.link, lineHeight: 18 },
  empty: { fontSize: 12, color: colors.hint, paddingBottom: spacing.sm },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  historyWhen: { fontSize: 12, color: colors.hint, minWidth: 58 },
  historyWhat: { fontSize: 13, color: colors.text, flex: 1 },
  status: { fontSize: 12, color: colors.hint },
  statusDone: { color: colors.accent, fontWeight: '600' },
  statusOff: { color: colors.warning, fontWeight: '700' },
});
