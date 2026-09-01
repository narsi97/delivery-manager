import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

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
import { useLanguage } from '../i18n';
import { labelsFor, lower } from '../labels';
import { openNavigation } from '../navigation';
import { colors, spacing } from '../theme';

// The driver's whole app. Everything is one column, one action per stop,
// with large touch targets — it gets used one-handed, outdoors, early.
//
// At real route sizes (20+ stops is an ordinary day, not an edge case)
// a full-height action card per stop is a wall of buttons to scroll
// through. Only the stop actually being driven to gets the full card;
// everything else is a single-line row that expands on tap — the same
// out-of-order stop (customer wasn't home earlier, driver circles back)
// is still one tap away, it just isn't taking up a screen's worth of
// space for the other 22 stops that aren't it.
export default function DriverScreen({ token, business }) {
  const labels = labelsFor(business);
  const { t } = useLanguage();
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
  // called out separately, with the full action card, so they never have
  // to scan the list to find it or to close it out.
  const nextStop = stops.find((stop) => stop.status === 'pending');
  const otherStops = stops.filter((stop) => stop.id !== nextStop?.id);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Banner message={error} />

      {/* The gate. Until the load is counted and agreed, there is nothing
          to show — so the screen shows the one thing there is to do
          instead of an empty list that looks like a quiet morning. */}
      {today?.checkin_required ? (
        <CheckinCard token={token} checkin={today.checkin} routeName={today?.route?.name} onDone={refresh} />
      ) : null}

      <Card>
        <SectionTitle>{today?.route?.name || t('nav_today')}</SectionTitle>
        {today?.checkin_required ? (
          <Empty>{t('checkin_stops_locked')}</Empty>
        ) : stops.length === 0 ? (
          <Empty>{t('no_route_assigned', { route: lower(labels.route) })}</Empty>
        ) : (
          <View style={styles.stats}>
            <Stat label={t('stops_label')} value={stops.length} />
            <Stat label={t('done_label')} value={done} tone="success" />
            <Stat label={t('left_label')} value={today?.remaining ?? 0} />
          </View>
        )}
      </Card>

      {nextStop ? (
        <Card style={styles.nextCard}>
          <Text style={styles.nextLabel}>{t('next_stop_heading')}</Text>
          <Text style={styles.nextName}>{nextStop.customer_name}</Text>
          <StopDetails stop={nextStop} />
          <StopActions
            stop={nextStop}
            token={token}
            captures={today?.captures}
            onChanged={refresh}
            onError={setError}
          />
        </Card>
      ) : null}

      {otherStops.map((stop) => (
        <CompactStopRow
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

// The address/quantity/notes block shown above the action buttons —
// shared by the always-open "next stop" card and whichever compact row
// is currently expanded, so there's exactly one place that decides what
// a driver sees about a stop.
function StopDetails({ stop }) {
  return (
    <>
      <Text style={styles.meta}>
        {stop.quantity} × {stop.product_name}
      </Text>
      {stop.customer_address ? <Text style={styles.address}>{stop.customer_address}</Text> : null}
      {stop.customer_notes ? <Text style={styles.customerNote}>{stop.customer_notes}</Text> : null}
      <CustomerDetails fields={stop.customer_fields} />
      {stop.note ? <Text style={styles.stopNote}>{stop.note}</Text> : null}
    </>
  );
}

// One collapsed-by-default row per non-next stop — sequence number, name,
// status. Tapping it expands the same detail + actions the next-stop card
// shows, so closing out a stop out of order never requires hunting
// through a long list of full-size cards to find it.
function CompactStopRow({ stop, token, captures, onChanged, onError }) {
  const { t } = useLanguage();
  const [expanded, setExpanded] = useState(false);
  const done = stop.status !== 'pending';
  const tone = { delivered: 'success', failed: 'error', skipped: 'warning' }[stop.status] || 'neutral';

  return (
    <Card style={done ? styles.doneCard : null}>
      <Pressable onPress={() => setExpanded((prev) => !prev)} accessibilityRole="button">
        <View style={styles.compactRow}>
          <Text style={[styles.compactName, done && styles.nameDone]} numberOfLines={1}>
            {stop.sequence}. {stop.customer_name}
          </Text>
          <Pill label={t(`status_${stop.status}`)} tone={tone} />
        </View>
      </Pressable>

      {expanded ? (
        <View style={styles.expandedStop}>
          <StopDetails stop={stop} />
          <StopActions stop={stop} token={token} captures={captures} onChanged={onChanged} onError={onError} />
        </View>
      ) : null}
    </Card>
  );
}

// The one place "choose an outcome → capture if the business requires it
// → submit" is implemented — used by both the next-stop card and an
// expanded compact row, so there is exactly one code path a stop can be
// closed through.
function StopActions({ stop, token, captures, onChanged, onError }) {
  const { t } = useLanguage();
  const [note, setNote] = useState('');
  // pendingStatus is the outcome the driver has chosen but not yet
  // confirmed. It exists only when the business declared something to
  // capture for that outcome — otherwise the first tap completes the stop,
  // because adding a confirmation step to a plain milk route would be
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

  if (stop.status !== 'pending') {
    return null;
  }

  const pendingCaptures = capturesForStatus(captures, pendingStatus);

  if (pendingStatus) {
    return (
      <View style={styles.captureBox}>
        <Text style={styles.captureTitle}>
          {pendingStatus === 'delivered' ? t('before_marking_delivered') : t('before_reporting_problem')}
        </Text>
        <DeclaredFields specs={pendingCaptures} values={captured} onChange={setCaptured} />
        <Field label={t('note_optional')} value={note} onChangeText={setNote} multiline />
        <View style={styles.buttonRow}>
          <Button
            title={t('confirm')}
            onPress={() => submit(pendingStatus, captured)}
            busy={busy === pendingStatus}
            style={styles.flexButton}
          />
          <Button title={t('back')} variant="secondary" onPress={() => setPendingStatus('')} style={styles.flexButton} />
        </View>
      </View>
    );
  }

  return (
    <View>
      <View style={styles.buttonRow}>
        <Button
          title={t('navigate')}
          variant="secondary"
          onPress={() => openNavigation(stop.lat, stop.lng, stop.customer_name)}
          style={styles.flexButton}
        />
        <Button title={t('delivered_action')} onPress={() => choose('delivered')} busy={busy === 'delivered'} style={styles.flexButton} />
      </View>
      <View style={styles.buttonRow}>
        <Button
          title={t('add_note')}
          variant="secondary"
          onPress={() => setPendingStatus('')}
          style={[styles.flexButton, styles.hiddenWhenNoCaptures]}
        />
        <Button title={t('couldnt_deliver')} variant="danger" onPress={() => choose('failed')} busy={busy === 'failed'} style={styles.flexButton} />
      </View>
    </View>
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

// What the driver does at the farm before anything else: count what is
// going on the van and say so. Nothing about the round is visible until
// somebody agrees with that number — see backend checkin.go for why the
// agreement rather than the number is the point.
function CheckinCard({ token, checkin, routeName, onDone }) {
  const { t } = useLanguage();
  const [units, setUnits] = useState(checkin?.units ? String(checkin.units) : '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const waiting = checkin?.status === 'pending';
  const rejected = checkin?.status === 'rejected';

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api.driverCheckin(token, Number(units), note);
      await onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={styles.checkinCard}>
      <Text style={styles.checkinHeading}>
        {t(waiting ? 'checkin_heading_waiting' : rejected ? 'checkin_heading_rejected' : 'checkin_heading_loading')}
      </Text>
      <Text style={styles.checkinLead}>
        {/* A rejection carries the admin's own words, which are the
            whole point of rejecting rather than just refusing — they
            stay as typed, in whatever language they were written. */}
        {waiting
          ? t('checkin_lead_waiting', { units: checkin.units, route: routeName || t('checkin_your_round') })
          : rejected
            ? checkin.review_note || t('checkin_lead_rejected')
            : t('checkin_lead_loading')}
      </Text>

      <Banner message={error} />

      {waiting ? null : (
        <View>
          {/* The count, then anything worth saying about it. "xs" keeps
              the box the size of the number that goes in it — a label
              longer than the box would wrap, which is why this one is
              two words. */}
          <Field
            label={t('checkin_units_label')}
            size="xs"
            value={units}
            onChangeText={setUnits}
            keyboardType="number-pad"
            placeholder={t('checkin_units_placeholder')}
          />
          <Field
            label={t('checkin_note_label')}
            size="md"
            value={note}
            onChangeText={setNote}
            placeholder={t('checkin_note_placeholder')}
          />
          <Button
            title={t(rejected ? 'checkin_resend' : 'checkin_send')}
            onPress={submit}
            busy={busy}
            disabled={!(Number(units) > 0)}
          />
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, maxWidth: 560, width: '100%', alignSelf: 'center' },
  loader: { marginTop: spacing.xl * 2 },
  checkinCard: { borderColor: colors.accent },
  checkinHeading: { fontSize: 18, fontWeight: '800', color: colors.text },
  checkinLead: { fontSize: 14, color: colors.subtitle, marginTop: spacing.xs, marginBottom: spacing.md, lineHeight: 20 },
  stats: { flexDirection: 'row' },
  nextCard: { borderColor: colors.accent, borderWidth: 2 },
  nextLabel: { fontSize: 11, fontWeight: '800', color: colors.accent, letterSpacing: 1 },
  nextName: { fontSize: 22, fontWeight: '800', color: colors.text, marginTop: spacing.xs },
  doneCard: { opacity: 0.6 },
  compactRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  compactName: { flex: 1, fontSize: 15, fontWeight: '700', color: colors.text, paddingRight: spacing.sm },
  expandedStop: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
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
