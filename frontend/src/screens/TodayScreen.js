import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import { Banner, Button, Card, Empty, Field, Pill, SectionTitle, Stat } from '../components';
import MapPicker from '../MapPicker';
import { currentPosition, openNavigation } from '../navigation';
import { colors, radius, spacing } from '../theme';

// The admin's operational screen: what is happening today, and the three
// actions that make it happen — generate the day from subscriptions,
// override individual stops, and build a route for a driver.
export default function TodayScreen({ token, business }) {
  const [day, setDay] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState('');

  const [depot, setDepot] = useState({ lat: '', lng: '', name: '' });

  const refresh = useCallback(async () => {
    try {
      const [dayResponse, driverResponse] = await Promise.all([api.getDay(token), api.listDrivers(token)]);
      setDay(dayResponse);
      setDrivers(driverResponse.drivers || []);
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

  const run = async (name, action) => {
    setBusyAction(name);
    setError('');
    setNotice('');
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyAction('');
    }
  };

  const generate = () =>
    run('generate', async () => {
      const result = await api.generateDay(token);
      setNotice(`Today has ${result.summary.total} deliveries.`);
    });

  const useMyLocation = async () => {
    const position = await currentPosition();
    if (!position) {
      setError('Could not read your location. Enter the depot coordinates by hand instead.');
      return;
    }
    setDepot({ lat: String(position.lat.toFixed(6)), lng: String(position.lng.toFixed(6)) });
  };

  const routes = day?.routes || [];

  // routeId absent = build a NEW route from whatever's still pending and
  // unrouted (how a day gets split across more than one driver). Passed =
  // rebuild that specific route in place, absorbing any stops added since
  // it was last built — either way, a stop already on a DIFFERENT route
  // is left alone (see selectRoutableOrders on the backend), so building
  // route two can never steal a stop already handed to route one.
  const build = (routeId) =>
    run(routeId ? `rebuild-${routeId}` : 'route', async () => {
      const lat = Number(depot.lat);
      const lng = Number(depot.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
        throw new Error('Set where the round starts from first — use your location, drop a pin, or type the coordinates.');
      }
      const result = await api.buildRoute(token, {
        start_lat: lat,
        start_lng: lng,
        name: depot.name.trim() || undefined,
        route_id: routeId || undefined,
      });
      const skipped = result.skipped_unpinned;
      setNotice(
        skipped > 0
          ? `Route built with ${result.stops.length} stops. ${skipped} customer(s) were left off — they have no location pinned yet.`
          : `Route built with ${result.stops.length} stops.`
      );
    });

  if (loading) {
    return <ActivityIndicator style={styles.loader} color={colors.accent} />;
  }

  const summary = day?.summary || {};

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Banner message={error} />
      <Banner message={notice} tone="success" />

      <Card>
        <SectionTitle>{formatDate(day?.date)}</SectionTitle>
        <View style={styles.stats}>
          <Stat label="Total" value={summary.total ?? 0} />
          <Stat label="Pending" value={summary.pending ?? 0} />
          <Stat label="Delivered" value={summary.delivered ?? 0} tone="success" />
          <Stat label="Failed" value={summary.failed ?? 0} tone="error" />
          <Stat label="Skipped" value={summary.skipped ?? 0} />
          <Stat label="Routes" value={routes.length} />
        </View>
        <Button
          title="Generate today's deliveries"
          onPress={generate}
          busy={busyAction === 'generate'}
        />
        <Text style={styles.note}>
          Builds today&apos;s list from every active subscription. Safe to run again after adding a customer — it never
          touches deliveries that already exist, including ones you&apos;ve changed or the driver has completed.
        </Text>
        {summary.unpinned > 0 ? (
          <Banner
            tone="info"
            message={`${summary.unpinned} customer(s) have no map pin yet, so they can't be routed.`}
          />
        ) : null}
      </Card>

      <Card>
        <SectionTitle>Routes ({routes.length})</SectionTitle>
        {routes.length === 0 ? (
          <Empty>No route built yet for today.</Empty>
        ) : (
          routes.map((route) => (
            <RouteSummary
              key={route.id}
              route={route}
              drivers={drivers}
              token={token}
              onChanged={refresh}
              onError={setError}
              onRebuild={() => build(route.id)}
              rebuilding={busyAction === `rebuild-${route.id}`}
            />
          ))
        )}

        <Text style={styles.label}>Where does the next round start?</Text>
        <Field
          label="Route name (optional)"
          value={depot.name}
          onChangeText={(value) => setDepot((prev) => ({ ...prev, name: value }))}
          placeholder={routes.length > 0 ? `Round ${routes.length + 1}` : 'Morning round'}
        />
        <View style={styles.depotRow}>
          <Field
            label="Latitude"
            value={depot.lat}
            onChangeText={(value) => setDepot((prev) => ({ ...prev, lat: value }))}
            keyboardType="numbers-and-punctuation"
            placeholder="12.9716"
            style={styles.depotInput}
          />
          <Field
            label="Longitude"
            value={depot.lng}
            onChangeText={(value) => setDepot((prev) => ({ ...prev, lng: value }))}
            keyboardType="numbers-and-punctuation"
            placeholder="77.5946"
            style={styles.depotInput}
          />
        </View>
        <MapPicker
          lat={Number(depot.lat) || 0}
          lng={Number(depot.lng) || 0}
          onChange={(lat, lng) => setDepot((prev) => ({ ...prev, lat: lat.toFixed(6), lng: lng.toFixed(6) }))}
        />
        <Button title="Use my current location" variant="secondary" onPress={useMyLocation} />
        <Button
          title="Build a new route"
          onPress={() => build()}
          busy={busyAction === 'route'}
          style={styles.spaced}
        />
        <Text style={styles.note}>
          Builds a route from every pending stop that isn&apos;t already on one of the routes above — this is how a
          day gets split across more than one driver. To absorb newly-added customers into an existing route instead,
          use that route&apos;s own &quot;Rebuild&quot; button. Stops are ordered nearest-first from the start point;
          turn-by-turn navigation happens in the driver&apos;s own map app.
        </Text>
      </Card>

      <SectionTitle>Deliveries</SectionTitle>
      {(day?.stops || []).length === 0 ? (
        <Card>
          <Empty>Nothing scheduled today. Add customers and subscriptions, then generate the day.</Empty>
        </Card>
      ) : (
        (day?.stops || []).map((stop) => (
          <StopCard key={stop.id} stop={stop} token={token} onChanged={refresh} onError={setError} />
        ))
      )}
    </ScrollView>
  );
}

function RouteSummary({ route, drivers, token, onChanged, onError, onRebuild, rebuilding }) {
  const [busy, setBusy] = useState(false);

  const assign = async (driverId) => {
    setBusy(true);
    try {
      await api.assignRoute(token, route.id, driverId);
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const assignedDriver = drivers.find((driver) => driver.id === route.driver_id);

  return (
    <View style={styles.routeBox}>
      <View style={styles.routeHeader}>
        <Text style={styles.routeName}>{route.name}</Text>
        <Pill label={route.status.replace('_', ' ')} tone={route.status === 'completed' ? 'success' : 'neutral'} />
      </View>
      <Text style={styles.routeMeta}>
        About {(route.estimated_meters / 1000).toFixed(1)} km of travel · {assignedDriver ? `Driver: ${assignedDriver.name}` : 'No driver assigned'}
      </Text>

      <Text style={styles.label}>Assign to</Text>
      <View style={styles.chipRow}>
        {drivers.filter((driver) => driver.active).map((driver) => (
          <Button
            key={driver.id}
            title={driver.name}
            variant={driver.id === route.driver_id ? 'primary' : 'secondary'}
            onPress={() => assign(driver.id === route.driver_id ? '' : driver.id)}
            busy={busy}
            style={styles.driverChip}
          />
        ))}
        {drivers.filter((driver) => driver.active).length === 0 ? (
          <Empty>Add a driver first.</Empty>
        ) : null}
      </View>

      {onRebuild ? (
        <Button
          title="Rebuild this route (uses the start point below)"
          variant="secondary"
          onPress={onRebuild}
          busy={rebuilding}
          style={styles.spaced}
        />
      ) : null}
    </View>
  );
}

function StopCard({ stop, token, onChanged, onError }) {
  const [editing, setEditing] = useState(false);
  const [quantity, setQuantity] = useState(String(stop.quantity));
  const [reason, setReason] = useState(stop.override_reason || '');
  const [busy, setBusy] = useState(false);

  const save = async (changes) => {
    setBusy(true);
    try {
      await api.overrideOrder(token, stop.id, changes);
      setEditing(false);
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const statusTone = { delivered: 'success', failed: 'error', skipped: 'warning' }[stop.status] || 'neutral';

  return (
    <Card>
      <View style={styles.stopHeader}>
        <View style={styles.stopHeaderText}>
          <Text style={styles.stopName}>
            {stop.sequence > 0 ? `${stop.sequence}. ` : ''}
            {stop.customer_name}
          </Text>
          <Text style={styles.stopMeta}>
            {stop.quantity} × {stop.product_name}
            {stop.base_quantity > 0 && stop.quantity !== stop.base_quantity
              ? `  (usually ${stop.base_quantity})`
              : ''}
          </Text>
          {stop.customer_address ? <Text style={styles.stopAddress}>{stop.customer_address}</Text> : null}
          {stop.override_reason ? <Text style={styles.stopReason}>{stop.override_reason}</Text> : null}
        </View>
        <Pill label={stop.status} tone={statusTone} />
      </View>

      {editing ? (
        <View style={styles.editor}>
          <Field label="Quantity today" value={quantity} onChangeText={setQuantity} keyboardType="numeric" />
          <Field
            label="Reason (optional)"
            value={reason}
            onChangeText={setReason}
            placeholder="Away this week / wants extra"
          />
          <View style={styles.buttonRow}>
            <Button
              title="Save"
              onPress={() => save({ quantity: Number(quantity), reason })}
              busy={busy}
              style={styles.flexButton}
            />
            <Button title="Cancel" variant="secondary" onPress={() => setEditing(false)} style={styles.flexButton} />
          </View>
          <Text style={styles.note}>
            This changes today only. The customer&apos;s standing subscription stays exactly as it is.
          </Text>
        </View>
      ) : (
        <View style={styles.buttonRow}>
          <Button title="Change today" variant="secondary" onPress={() => setEditing(true)} style={styles.flexButton} />
          {stop.status === 'skipped' ? (
            <Button
              title="Un-skip"
              variant="secondary"
              onPress={() => save({ status: 'pending', quantity: stop.base_quantity || 1 })}
              busy={busy}
              style={styles.flexButton}
            />
          ) : (
            <Button
              title="Skip today"
              variant="danger"
              onPress={() => save({ status: 'skipped', reason: 'skipped by admin' })}
              busy={busy}
              style={styles.flexButton}
            />
          )}
          {stop.lat || stop.lng ? (
            <Button
              title="Map"
              variant="secondary"
              onPress={() => openNavigation(stop.lat, stop.lng, stop.customer_name)}
              style={styles.flexButton}
            />
          ) : null}
        </View>
      )}
    </Card>
  );
}

function formatDate(date) {
  if (!date) {
    return 'Today';
  }
  // Parsed as UTC deliberately: the string is already the business's own
  // calendar day, so re-interpreting it in the device's zone could shift
  // the displayed date by one.
  const parsed = new Date(`${date}T00:00:00Z`);
  return parsed.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, maxWidth: 720, width: '100%', alignSelf: 'center' },
  loader: { marginTop: spacing.xl * 2 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: spacing.md },
  note: { fontSize: 12, color: colors.hint, marginTop: spacing.sm, lineHeight: 17 },
  label: { fontSize: 13, fontWeight: '600', color: colors.label, marginTop: spacing.md, marginBottom: spacing.xs },
  depotRow: { flexDirection: 'row', gap: spacing.md },
  depotInput: { minWidth: 120 },
  spaced: { marginTop: spacing.sm },
  routeBox: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  routeHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  routeName: { fontSize: 15, fontWeight: '700', color: colors.text },
  routeMeta: { fontSize: 13, color: colors.subtitle, marginTop: spacing.xs },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  driverChip: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md, minHeight: 38 },
  stopHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  stopHeaderText: { flex: 1, paddingRight: spacing.sm },
  stopName: { fontSize: 16, fontWeight: '700', color: colors.text },
  stopMeta: { fontSize: 14, color: colors.label, marginTop: 2 },
  stopAddress: { fontSize: 13, color: colors.subtitle, marginTop: 2 },
  stopReason: { fontSize: 13, color: colors.warning, marginTop: 2, fontStyle: 'italic' },
  editor: { marginTop: spacing.md },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, flexWrap: 'wrap' },
  flexButton: { flex: 1, minWidth: 110 },
});
