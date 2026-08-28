import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import { Banner, Button, Card, Disclosure, Empty, Field, FieldRow, SectionTitle, Stepper } from '../components';
import DateNav from '../DateNav';
import MapPicker from '../MapPicker';
import { currentPosition } from '../navigation';
import { RouteSummary } from '../routeCards';
import { nearestAreaFor } from '../serviceAreas';
import { colors, spacing } from '../theme';

// The "manage rounds" home for a day.
//
// Rounds are not built by hand any more. The backend derives one round
// per service area that has deliveries in it, every day, and puts each
// stop on the round that serves its area (see ensureDayRounds in
// httpapi/admin.go). So the way to get a new round is to add a service
// area on the Business tab — not to fill in a depot form here.
//
// What's left for this screen is what genuinely still needs a human:
// seeing the day's rounds, assigning drivers, and dealing with the
// stragglers — customers whose pin falls outside every service area, who
// deliberately are *not* auto-absorbed onto a round they don't belong to.
export default function RoutesScreen({ token, business }) {
  const [day, setDay] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const [areas, setAreas] = useState([]);
  const [products, setProducts] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState('');

  // Independent of TodayScreen's own date selection — every screen in
  // this app manages its own state, and looking ahead to next Tuesday's
  // routes here shouldn't strand an admin on next Tuesday when they flip
  // back to check today's delivery count.
  const [selectedDate, setSelectedDate] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [dayResponse, driverResponse, areaResponse, productResponse] = await Promise.all([
        api.getDay(token, selectedDate || undefined),
        api.listDrivers(token),
        api.listServiceAreas(token),
        api.listProducts(token),
      ]);
      setDay(dayResponse);
      setDrivers(driverResponse.drivers || []);
      setAreas(areaResponse.service_areas || []);
      setProducts(productResponse.products || []);
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

  // Re-optimizes an existing round from its own stored start point and
  // keeps its existing name — see the identical helper (and the fuller
  // comment) on TodayScreen.js, which shows the same rounds and needs the
  // same behavior for its own copy of this button.
  const rebuild = async (route) => {
    setBusyAction(`rebuild-${route.id}`);
    setError('');
    setNotice('');
    try {
      const result = await api.buildRoute(token, {
        start_lat: route.start_lat,
        start_lng: route.start_lng,
        name: route.name,
        route_id: route.id,
        date: selectedDate || undefined,
      });
      setNotice(`${route.name}: re-optimized with ${result.stops.length} stops.`);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyAction('');
    }
  };

  if (loading) {
    return <ActivityIndicator style={styles.loader} color={colors.accent} />;
  }

  const routes = day?.routes || [];
  const home = business.home_lat || business.home_lng ? { lat: business.home_lat, lng: business.home_lng } : null;

  // The stragglers: pending, pinned, and on no round. After
  // ensureDayRounds has run, the only stops left here are ones whose pin
  // falls outside every service area — so this list is exactly "customers
  // you deliver to but haven't drawn a zone around yet".
  const strays = (day?.stops || []).filter(
    (stop) => stop.status === 'pending' && !stop.route_id && (stop.lat || stop.lng)
  );

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Banner message={notice} tone="success" />

      <Card>
        <DateNav date={day?.date} selectedDate={selectedDate} onSelect={setSelectedDate} />
        <View style={styles.routesSection}>
          <SectionTitle>Rounds ({routes.length})</SectionTitle>
          <Banner message={error} />
          {routes.length === 0 ? (
            <Empty>
              No rounds for this day. Rounds are prepared automatically for each service area that has deliveries —
              add one on the Business tab.
            </Empty>
          ) : (
            routes.map((route) => (
              <RouteSummary
                key={route.id}
                route={route}
                drivers={drivers}
                stops={day?.stops || []}
                products={products}
                token={token}
                onChanged={refresh}
                onError={setError}
                onRebuild={() => rebuild(route)}
                rebuilding={busyAction === `rebuild-${route.id}`}
              />
            ))
          )}
          <Text style={styles.note}>
            One round per service area, prepared for every day automatically. New customers join the round for their
            area on their own — add a service area on the Business tab to get another round.
          </Text>
        </View>
      </Card>

      <PlanRoundsCard
        token={token}
        date={selectedDate}
        stopCount={(day?.stops || []).filter((stop) => stop.status === 'pending' && (stop.lat || stop.lng)).length}
        currentRounds={routes.length}
        hasHome={!!home}
        onDone={async (message) => {
          setNotice(message);
          await refresh();
        }}
      />

      {strays.length > 0 ? (
        <StrayStopsCard
          token={token}
          stops={strays}
          areas={areas}
          home={home}
          date={selectedDate}
          onDone={async (message) => {
            setNotice(message);
            await refresh();
          }}
        />
      ) : null}
    </ScrollView>
  );
}

// Splitting the day across however many drivers are actually out.
//
// The automatic rounds answer "where do we deliver" — one per service
// area, every day, no thought required. This answers a question areas
// can't: a business with two areas and four vans, or four vans and a
// driver off sick, needs the same work cut a different number of ways.
// So this is a deliberate act with a button, not something that happens
// on its own, and it says plainly that it replaces the current plan.
function PlanRoundsCard({ token, date, stopCount, currentRounds, hasHome, onDone }) {
  const [expanded, setExpanded] = useState(false);
  const [count, setCount] = useState(Math.max(1, currentRounds || 1));
  const [returnHome, setReturnHome] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const plan = async () => {
    setBusy(true);
    setError('');
    try {
      await api.planRounds(token, { count, return_home: returnHome, date: date || undefined });
      await onDone(`Split ${stopCount} deliveries across ${count} round${count === 1 ? '' : 's'}.`);
      setExpanded(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Disclosure open={expanded} onToggle={() => setExpanded((prev) => !prev)}>
        Split the day across drivers
      </Disclosure>

      {expanded ? (
        <View>
          <Banner message={error} />
          {hasHome ? null : (
            <Banner
              tone="info"
              message="Set your home location on the Business tab first — rounds have to start somewhere."
            />
          )}
          <Stepper
            label="How many rounds"
            value={count}
            onChange={setCount}
            min={1}
            max={10}
            hint={`${stopCount} deliveries to share out. One round per driver going out today.`}
          />
          <Pressable
            onPress={() => setReturnHome((prev) => !prev)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: returnHome }}
            style={styles.toggleRow}
          >
            <Text style={styles.toggleBox}>{returnHome ? '☑' : '☐'}</Text>
            <Text style={styles.toggleLabel}>Driver finishes back at the start</Text>
          </Pressable>
          <Text style={styles.note}>
            With this on, the drive home counts as part of the round — which changes the order stops are visited
            in, not just the distance shown.
          </Text>
          <Button
            title={`Plan ${count} round${count === 1 ? '' : 's'}`}
            onPress={plan}
            busy={busy}
            disabled={!hasHome || stopCount === 0}
            style={styles.spaced}
          />
          <Text style={styles.note}>
            Replaces this day&apos;s current rounds. Deliveries already completed keep the round they were made
            on.
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

// The one case that still needs a human: deliveries whose customer sits
// outside every service area. They are deliberately never auto-absorbed —
// putting a customer 60km away on whichever round happened to exist is
// exactly the bug that made this rewrite necessary — so they surface here
// with the two real ways out: draw a service area around them (the fix
// that also handles tomorrow), or put them on a one-off round today.
//
// Owns its own error state rather than pushing it to a banner at the top
// of the page: an error about this action belongs next to this action,
// where the person who pressed the button is already looking.
function StrayStopsCard({ token, stops, areas, home, date, onDone }) {
  const [expanded, setExpanded] = useState(false);
  const [depot, setDepot] = useState(() =>
    home ? { lat: String(home.lat), lng: String(home.lng) } : { lat: '', lng: '' }
  );
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const useMyLocation = async () => {
    const position = await currentPosition();
    if (!position) {
      setError('Could not read your location. Type the coordinates instead, or drop the pin on the map.');
      return;
    }
    setDepot({ lat: position.lat.toFixed(6), lng: position.lng.toFixed(6) });
  };

  const build = async () => {
    const lat = Number(depot.lat);
    const lng = Number(depot.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
      setError('Set where this round starts from first — use your location, drop a pin, or type the coordinates.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const area = nearestAreaFor(lat, lng, areas);
      const result = await api.buildRoute(token, {
        start_lat: lat,
        start_lng: lng,
        name: name.trim() || (area ? `${area.name} round` : 'Extra round'),
        order_ids: stops.map((stop) => stop.id),
        date: date || undefined,
      });
      await onDone(`Round built with ${result.stops.length} stops.`);
      setExpanded(false);
      setName('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <SectionTitle>Outside your service areas ({stops.length})</SectionTitle>
      <Text style={styles.note}>
        These deliveries have a pin but sit outside every service area, so no round covers them. The lasting fix is
        to add a service area around them on the Business tab — then they get their own round every day. To handle
        just today, build a one-off round for them here.
      </Text>

      {stops.slice(0, 5).map((stop) => (
        <Text key={stop.id} style={styles.strayLine}>
          {stop.customer_name}
          {stop.customer_address ? ` · ${stop.customer_address}` : ''}
        </Text>
      ))}
      {stops.length > 5 ? <Text style={styles.strayLine}>…and {stops.length - 5} more</Text> : null}

      <Disclosure open={expanded} onToggle={() => setExpanded((prev) => !prev)}>
        Build a one-off round for these
      </Disclosure>

      {expanded ? (
        <View>
          <Banner message={error} />
          <Field label="Round name" size="md" value={name} onChangeText={setName} placeholder="Extra round" />
          <FieldRow>
            <Field
              label="Starts at latitude"
              size="sm"
              value={depot.lat}
              onChangeText={(value) => setDepot((prev) => ({ ...prev, lat: value }))}
              placeholder="16.8713"
            />
            <Field
              label="Longitude"
              size="sm"
              value={depot.lng}
              onChangeText={(value) => setDepot((prev) => ({ ...prev, lng: value }))}
              placeholder="79.5611"
            />
          </FieldRow>
          <MapPicker
            lat={Number(depot.lat) || 0}
            lng={Number(depot.lng) || 0}
            onChange={(lat, lng) => setDepot({ lat: lat.toFixed(6), lng: lng.toFixed(6) })}
            home={home}
            areas={areas}
          />
          <Button title="Use my current location" variant="secondary" onPress={useMyLocation} />
          <Button title={`Build a round for these ${stops.length}`} onPress={build} busy={busy} style={styles.spaced} />
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, maxWidth: 720, width: '100%', alignSelf: 'center' },
  loader: { marginTop: spacing.xl * 2 },
  note: { fontSize: 12, color: colors.hint, marginTop: spacing.sm, lineHeight: 17 },
  routesSection: { marginTop: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.lg },
  spaced: { marginTop: spacing.sm },
  strayLine: { fontSize: 13, color: colors.label, marginTop: spacing.xs },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44 },
  toggleBox: { fontSize: 20, color: colors.link },
  toggleLabel: { fontSize: 15, color: colors.text, fontWeight: '600' },
});
