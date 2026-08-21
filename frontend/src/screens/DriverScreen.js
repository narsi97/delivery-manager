import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import {
  Banner,
  Button,
  Card,
  capturesForStatus,
  DeclaredFields,
  Empty,
  Field,
  Pill,
  SectionTitle,
  Stat,
} from '../components';
import { labelsFor, lower } from '../labels';
import { openNavigation } from '../navigation';
import { colors, spacing } from '../theme';

// The driver's whole app. Everything is one column, one action per stop,
// with large touch targets — it gets used one-handed, outdoors, early.
export default function DriverScreen({ token, business }) {
  const labels = labelsFor(business);
  const [today, setToday] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      setToday(await api.getDriverToday(token));
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading) {
    return <ActivityIndicator style={styles.loader} color={colors.accent} />;
  }

  const stops = today?.stops || [];
  const done = stops.filter((stop) => stop.status !== 'pending').length;
  // The next open stop is the one the driver is actually driving to; it's
  // called out separately so they never have to scan the list to find it.
  const nextStop = stops.find((stop) => stop.status === 'pending');

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Banner message={error} />

      <Card>
        <SectionTitle>{today?.route?.name || 'Today'}</SectionTitle>
        {stops.length === 0 ? (
          <Empty>No {lower(labels.route)} assigned to you yet. Check back once your manager has planned the day.</Empty>
        ) : (
          <View style={styles.stats}>
            <Stat label="Stops" value={stops.length} />
            <Stat label="Done" value={done} tone="success" />
            <Stat label="Left" value={today?.remaining ?? 0} />
          </View>
        )}
      </Card>

      {nextStop ? (
        <Card style={styles.nextCard}>
          <Text style={styles.nextLabel}>NEXT STOP</Text>
          <Text style={styles.nextName}>{nextStop.customer_name}</Text>
          <Text style={styles.nextMeta}>
            {nextStop.quantity} × {nextStop.product_name}
          </Text>
          {nextStop.customer_address ? <Text style={styles.nextAddress}>{nextStop.customer_address}</Text> : null}
          <Button
            title="Navigate"
            onPress={() => openNavigation(nextStop.lat, nextStop.lng, nextStop.customer_name)}
            style={styles.navButton}
          />
        </Card>
      ) : null}

      {stops.map((stop) => (
        <StopCard
          key={stop.id}
          stop={stop}
          token={token}
          captures={today?.captures}
          onChanged={refresh}
          onError={setError}
        />
      ))}
    </ScrollView>
  );
}

function StopCard({ stop, token, captures, onChanged, onError }) {
  const [note, setNote] = useState('');
  // pendingStatus is the outcome the driver has chosen but not yet
  // confirmed. It exists only when the business declared something to
  // capture for that outcome — otherwise the first tap completes the stop,
  // because adding a confirmation step to a plain milk round would be
  // making every driver pay for a feature one business asked for.
  const [pendingStatus, setPendingStatus] = useState('');
  const [captured, setCaptured] = useState({});
  const [busy, setBusy] = useState('');

  const submit = async (status, values) => {
    setBusy(status);
    try {
      await api.setStopStatus(token, stop.id, status, note, values);
      setPendingStatus('');
      setCaptured({});
      setNote('');
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy('');
    }
  };

  const choose = (status) => {
    const required = capturesForStatus(captures, status);
    if (required.length === 0) {
      submit(status, {});
      return;
    }
    setPendingStatus(status);
    setCaptured({});
  };

  const tone = { delivered: 'success', failed: 'error', skipped: 'warning' }[stop.status] || 'neutral';
  const done = stop.status !== 'pending';
  const pendingCaptures = capturesForStatus(captures, pendingStatus);

  return (
    <Card style={done ? styles.doneCard : null}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={[styles.name, done && styles.nameDone]}>
            {stop.sequence}. {stop.customer_name}
          </Text>
          <Text style={styles.meta}>
            {stop.quantity} × {stop.product_name}
          </Text>
          {stop.customer_address ? <Text style={styles.address}>{stop.customer_address}</Text> : null}
          {stop.customer_notes ? <Text style={styles.customerNote}>{stop.customer_notes}</Text> : null}
          <CustomerDetails fields={stop.customer_fields} />
          {stop.note ? <Text style={styles.stopNote}>{stop.note}</Text> : null}
        </View>
        <Pill label={stop.status} tone={tone} />
      </View>

      {done ? null : pendingStatus ? (
        <View style={styles.captureBox}>
          <Text style={styles.captureTitle}>
            {pendingStatus === 'delivered' ? 'Before marking delivered' : 'Before reporting a problem'}
          </Text>
          <DeclaredFields specs={pendingCaptures} values={captured} onChange={setCaptured} />
          <Field label="Note (optional)" value={note} onChangeText={setNote} multiline />
          <View style={styles.buttonRow}>
            <Button
              title="Confirm"
              onPress={() => submit(pendingStatus, captured)}
              busy={busy === pendingStatus}
              style={styles.flexButton}
            />
            <Button
              title="Back"
              variant="secondary"
              onPress={() => setPendingStatus('')}
              style={styles.flexButton}
            />
          </View>
        </View>
      ) : (
        <View>
          <View style={styles.buttonRow}>
            <Button
              title="Navigate"
              variant="secondary"
              onPress={() => openNavigation(stop.lat, stop.lng, stop.customer_name)}
              style={styles.flexButton}
            />
            <Button
              title="Delivered"
              onPress={() => choose('delivered')}
              busy={busy === 'delivered'}
              style={styles.flexButton}
            />
          </View>
          <View style={styles.buttonRow}>
            <Button
              title="Add a note"
              variant="secondary"
              onPress={() => setPendingStatus('')}
              style={[styles.flexButton, styles.hiddenWhenNoCaptures]}
            />
            <Button
              title="Couldn't deliver"
              variant="danger"
              onPress={() => choose('failed')}
              busy={busy === 'failed'}
              style={styles.flexButton}
            />
          </View>
        </View>
      )}
    </Card>
  );
}

// CustomerDetails surfaces whatever the business keeps about this
// customer — a guardian's phone, a gate code — at the door, so the driver
// never needs a second request on a bad connection to find it.
function CustomerDetails({ fields }) {
  const entries = Object.entries(fields || {});
  if (entries.length === 0) {
    return null;
  }
  return (
    <View style={styles.customerFields}>
      {entries.map(([key, value]) => (
        <Text key={key} style={styles.customerField}>
          {key.replace(/_/g, ' ')}: {String(value)}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, maxWidth: 560, width: '100%', alignSelf: 'center' },
  loader: { marginTop: spacing.xl * 2 },
  stats: { flexDirection: 'row' },
  nextCard: { borderColor: colors.accent, borderWidth: 2 },
  nextLabel: { fontSize: 11, fontWeight: '800', color: colors.accent, letterSpacing: 1 },
  nextName: { fontSize: 22, fontWeight: '800', color: colors.text, marginTop: spacing.xs },
  nextMeta: { fontSize: 16, color: colors.label, marginTop: 2 },
  nextAddress: { fontSize: 14, color: colors.subtitle, marginTop: 2 },
  navButton: { marginTop: spacing.md },
  doneCard: { opacity: 0.6 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  headerText: { flex: 1, paddingRight: spacing.sm },
  name: { fontSize: 17, fontWeight: '700', color: colors.text },
  nameDone: { textDecorationLine: 'line-through' },
  meta: { fontSize: 15, color: colors.label, marginTop: 2 },
  address: { fontSize: 13, color: colors.subtitle, marginTop: 2 },
  customerNote: { fontSize: 13, color: colors.warning, marginTop: spacing.xs },
  stopNote: { fontSize: 13, color: colors.subtitle, marginTop: spacing.xs, fontStyle: 'italic' },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  flexButton: { flex: 1 },
  hiddenWhenNoCaptures: { opacity: 0, pointerEvents: 'none' },
  captureBox: { marginTop: spacing.md },
  captureTitle: { fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  customerFields: { marginTop: spacing.xs },
  customerField: { fontSize: 13, color: colors.subtitle, textTransform: 'capitalize' },
});
