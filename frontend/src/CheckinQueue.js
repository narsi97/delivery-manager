import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import * as api from './api';
import { Banner, Button, Card, Field, Pill, SectionTitle } from './components';
import { colors, radius, spacing } from './theme';

// The office side of the gate: who is standing at the farm waiting to be
// let go, and what they say they have loaded.
//
// This is deliberately at the top of the day screen and impossible to
// collapse while anyone is waiting. Everything else on Today can be
// looked at later; a driver standing next to a van cannot.
export default function CheckinQueue({ token, checkins, drivers, date, onChanged }) {
  const waiting = (checkins || []).filter((c) => c.status === 'pending');
  if (waiting.length === 0) {
    return null;
  }

  return (
    <Card style={styles.card}>
      <SectionTitle right={<Pill label={String(waiting.length)} tone="warning" />}>
        {waiting.length === 1 ? 'A driver is waiting' : 'Drivers are waiting'}
      </SectionTitle>
      <View style={styles.divider} />
      <Text style={styles.lead}>
        They are at the farm with a load counted. Their stops stay hidden until you agree with the number.
      </Text>

      {waiting.map((checkin) => (
        <CheckinRow
          key={checkin.id}
          token={token}
          checkin={checkin}
          driver={(drivers || []).find((d) => d.id === checkin.driver_id)}
          date={date}
          onChanged={onChanged}
        />
      ))}
    </Card>
  );
}

// The counts drivers have sent and nobody needs to act on — every count,
// once approval is off. Said beside what the driver's round actually
// needs, because a count on its own is a number nobody can check: "59"
// means something only next to "needs 59".
export function LoadsSent({ checkins, drivers, routes = [], stops = [] }) {
  const sent = (checkins || []).filter((c) => c.status !== 'pending');
  if (sent.length === 0) {
    return null;
  }

  return (
    <Card>
      <SectionTitle>Loads sent</SectionTitle>
      {sent.map((checkin) => {
        const driver = (drivers || []).find((d) => d.id === checkin.driver_id);
        const theirRoutes = new Set(routes.filter((r) => r.driver_id === checkin.driver_id).map((r) => r.id));
        // Skipped stops are not going on the van, so they are not part
        // of what the count should come to.
        const needed = stops
          .filter((stop) => theirRoutes.has(stop.route_id) && stop.status !== 'skipped')
          .reduce((sum, stop) => sum + (Number(stop.quantity) || 0), 0);
        const gap = checkin.units - needed;
        return (
          <View key={checkin.id} style={styles.sentRow}>
            <View style={styles.rowText}>
              <Text style={styles.sentName}>{driver ? driver.name : 'A driver'}</Text>
              <Text style={styles.meta}>
                loaded {checkin.units}
                {theirRoutes.size > 0 ? ` · round needs ${needed}` : ''}
                {checkin.note ? ` · ${checkin.note}` : ''}
              </Text>
            </View>
            {theirRoutes.size === 0 ? null : gap === 0 ? (
              <Pill label="matches" tone="success" />
            ) : (
              <Pill label={gap < 0 ? `${-gap} short` : `${gap} over`} tone="warning" />
            )}
          </View>
        );
      })}
    </Card>
  );
}

function CheckinRow({ token, checkin, driver, date, onChanged }) {
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const review = async (approve) => {
    setBusy(true);
    setError('');
    try {
      await api.reviewCheckin(token, checkin.driver_id, approve, note, date);
      await onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.row}>
      <View style={styles.rowHead}>
        <View style={styles.rowText}>
          <Text style={styles.name}>{driver ? driver.name : 'A driver'}</Text>
          <Text style={styles.meta}>
            says {checkin.units} loaded
            {checkin.note ? ` · ${checkin.note}` : ''}
          </Text>
        </View>
      </View>

      <Banner message={error} />

      {rejecting ? (
        <View>
          {/* A rejection owes the driver something they can act on. "12
              short — recount" is useful standing at the farm; a bare no
              is not, and the endpoint refuses one. */}
          <Field
            label="What's wrong?"
            size="md"
            value={note}
            onChangeText={setNote}
            placeholder="12 short — recount"
            autoFocus
          />
          <View style={styles.buttons}>
            <Button
              title="Send it back"
              variant="danger"
              onPress={() => review(false)}
              busy={busy}
              disabled={!note.trim()}
              style={styles.button}
            />
            <Button title="Cancel" variant="secondary" onPress={() => setRejecting(false)} style={styles.button} />
          </View>
        </View>
      ) : (
        <View style={styles.buttons}>
          <Button title="Approve" onPress={() => review(true)} busy={busy} style={styles.button} />
          <Button title="Not right" variant="secondary" onPress={() => setRejecting(true)} style={styles.button} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderColor: colors.warning || colors.border },
  divider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginTop: -spacing.sm,
    marginBottom: spacing.sm,
  },
  lead: { fontSize: 13, color: colors.subtitle, marginBottom: spacing.sm, lineHeight: 18 },
  row: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    marginBottom: spacing.sm,
  },
  rowHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.sm },
  rowText: { flexShrink: 1 },
  name: { fontSize: 16, fontWeight: '700', color: colors.text },
  meta: { fontSize: 13, color: colors.subtitle, marginTop: 2 },
  buttons: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, flexWrap: 'wrap' },
  button: { flex: 1, minWidth: 130 },
  sentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  sentName: { fontSize: 15, fontWeight: '700', color: colors.text },
});
