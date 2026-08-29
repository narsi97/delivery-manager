import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import { Banner, Button, Card, Disclosure, Empty, Field, SectionTitle, Stepper } from '../components';
import DateNav from '../DateNav';
import DayRouteMapCard from '../DayRouteMapCard';
import LocationPicker from '../LocationPicker';
import { RouteSummary } from '../routeCards';
import { nearestAreaFor } from '../serviceAreas';
import { colors, spacing } from '../theme';

// Where a day's routes are made and checked.
//
// Three ways to get a route, in the order an admin reaches for them:
// the backend prepares one per service area on its own (see
// ensureDayRoutes), "Create routes" makes them deliberately — either one
// named route, or several at once cut from the day's stops — and the map
// below is where the result gets checked and corrected by hand.
//
// The map matters more than it sounds. A split that reads fine as
// numbers ("6, 6, 6, 4") can be obviously wrong on a map: two routes
// interleaved down one street, or a stop stranded the wrong side of a
// level crossing. Seeing the colours is how an admin catches that, and
// tapping a pin is how they fix it.
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

  // Re-optimizes an existing route from its own stored start point and
  // keeps its existing name — see the identical helper (and the fuller
  // comment) on TodayScreen.js, which shows the same routes and needs the
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

  const resetDay = async () => {
    setBusyAction('reset');
    setError('');
    setNotice('');
    try {
      await api.resetRoutes(token, selectedDate || undefined);
      setNotice('Routes cleared. Any deliveries already completed kept theirs.');
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyAction('');
    }
  };

  const removeRoute = async (route) => {
    setBusyAction(`delete-${route.id}`);
    setError('');
    setNotice('');
    try {
      await api.deleteRoute(token, route.id);
      setNotice(`${route.name} deleted. Its deliveries are back on the unassigned list.`);
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

  // The stragglers: pending, pinned, and on no route. After
  // ensureDayRoutes has run, the only stops left here are ones whose pin
  // falls outside every service area — so this list is exactly "customers
  // you deliver to but haven't drawn a zone around yet".
  // Every stop with a pin, routed or not — the map is for verifying the
  // whole day's assignment, so an unrouted stop has to be visible on it
  // too (that is often the thing being looked for).
  const mappableStops = (day?.stops || []).filter((stop) => stop.lat || stop.lng);

  const strays = (day?.stops || []).filter(
    (stop) => stop.status === 'pending' && !stop.route_id && (stop.lat || stop.lng)
  );

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Banner message={notice} tone="success" />

      <Card>
        <DateNav date={day?.date} selectedDate={selectedDate} onSelect={setSelectedDate} />
        <View style={styles.routesSection}>
          <SectionTitle>Routes ({routes.length})</SectionTitle>
          <Banner message={error} />
          {routes.length === 0 ? (
            <Empty>
              No routes for this day. Routes are prepared automatically for each service area that has deliveries —
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
                onDelete={() => removeRoute(route)}
                deleting={busyAction === `delete-${route.id}`}
              />
            ))
          )}
          {routes.length > 0 ? (
            <Button
              title="Clear all routes for this day"
              variant="secondary"
              onPress={resetDay}
              busy={busyAction === 'reset'}
              style={styles.spaced}
            />
          ) : null}
          <Text style={styles.note}>
            One route per service area, prepared for every day automatically. New customers join the route for their
            area on their own — add a service area on the Business tab to get another route.
          </Text>
        </View>
      </Card>

      {mappableStops.length > 0 ? (
        <DayRouteMapCard
          token={token}
          stops={mappableStops}
          routes={routes}
          drivers={drivers}
          home={home}
          onChanged={refresh}
        />
      ) : null}

      <CreateRoutesCard
        token={token}
        date={selectedDate}
        stopCount={(day?.stops || []).filter((stop) => stop.status === 'pending' && (stop.lat || stop.lng)).length}
        currentRoutes={routes.length}
        home={home}
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

// Creating routes.
//
// Two ways, because there are genuinely two situations. "One route" is
// the deliberate one — name it, say where it starts, and it can be empty
// to begin with, because stops get moved onto it from the map above.
// "Several at once" cuts the day's stops geographically across however
// many drivers are actually out, which is the thing you cannot express
// by adding service areas: a business with two areas and four vans, or
// four vans and a driver off sick, is the same map and a different plan.
//
// Both live here rather than being spread around, because both answer
// the same question an admin arrives at this tab with — "how do I get
// the routes I want for today".
function CreateRoutesCard({ token, date, stopCount, currentRoutes, home, onDone }) {
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState('one');

  return (
    <Card>
      <Disclosure open={expanded} onToggle={() => setExpanded((prev) => !prev)}>
        Create routes
      </Disclosure>

      {expanded ? (
        <View>
          <View style={styles.modeRow}>
            <Button
              title="One route"
              variant={mode === 'one' ? 'primary' : 'secondary'}
              onPress={() => setMode('one')}
              style={styles.modeButton}
            />
            <Button
              title="Several at once"
              variant={mode === 'many' ? 'primary' : 'secondary'}
              onPress={() => setMode('many')}
              style={styles.modeButton}
            />
          </View>

          {mode === 'one' ? (
            <NewRouteForm token={token} date={date} home={home} onDone={onDone} />
          ) : (
            <SplitAcrossDriversForm
              token={token}
              date={date}
              stopCount={stopCount}
              currentRoutes={currentRoutes}
              home={home}
              onDone={onDone}
            />
          )}
        </View>
      ) : null}
    </Card>
  );
}

// One named route. Starts empty unless there is unrouted work to pick up,
// which is deliberate: an admin who wants "Evening route" wants the route
// to exist so they can move the late customers onto it, and refusing to
// make one because everything currently happens to be assigned is exactly
// backwards.
function NewRouteForm({ token, date, home, onDone }) {
  const [name, setName] = useState('');
  const [depot, setDepot] = useState(() =>
    home ? { lat: String(home.lat), lng: String(home.lng) } : { lat: '', lng: '' }
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    const lat = Number(depot.lat);
    const lng = Number(depot.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
      setError('Set where this route starts from — drop the pin, or type the coordinates.');
      return;
    }
    if (!name.trim()) {
      setError('Give the route a name so a driver knows which one it is.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api.buildRoute(token, {
        name: name.trim(),
        start_lat: lat,
        start_lng: lng,
        date: date || undefined,
        allow_empty: true,
      });
      await onDone(`${name.trim()} created.`);
      setName('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <Banner message={error} />
      <Field label="Route name" size="md" value={name} onChangeText={setName} placeholder="Evening route" />
      <LocationPicker
        label="Where does this route start?"
        lat={Number(depot.lat) || 0}
        lng={Number(depot.lng) || 0}
        onChange={(lat, lng) => setDepot({ lat: lat.toFixed(6), lng: lng.toFixed(6) })}
        home={home}
      />
      <Button title="Create route" onPress={create} busy={busy} style={styles.spaced} />
      <Text style={styles.note}>
        Picks up any deliveries not yet on a route. If there aren&apos;t any, the route is created empty — move
        stops onto it from the map above.
      </Text>
    </View>
  );
}

// Several routes at once, cut geographically from the day's stops.
function SplitAcrossDriversForm({ token, date, stopCount, currentRoutes, home, onDone }) {
  const [count, setCount] = useState(Math.max(2, currentRoutes || 2));
  const [returnHome, setReturnHome] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const plan = async () => {
    setBusy(true);
    setError('');
    try {
      await api.planRoutes(token, { count, return_home: returnHome, date: date || undefined });
      await onDone(`Split ${stopCount} deliveries across ${count} routes.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <Banner message={error} />
      {home ? null : (
        <Banner
          tone="info"
          message="Set your home location on the Business tab first — routes have to start somewhere."
        />
      )}
      <Stepper
        label="How many routes"
        value={count}
        onChange={setCount}
        min={1}
        max={10}
        hint={`${stopCount} deliveries to share out. One route per driver going out today.`}
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
        With this on, the drive home counts as part of the route — which changes the order stops are visited in,
        not just the distance shown.
      </Text>
      <Button
        title={`Create ${count} routes`}
        onPress={plan}
        busy={busy}
        disabled={!home || stopCount === 0}
        style={styles.spaced}
      />
      <Text style={styles.note}>
        Replaces this day&apos;s current routes. Deliveries already completed keep the route they were made on.
      </Text>
    </View>
  );
}

// The one case that still needs a human: deliveries whose customer sits
// outside every service area. They are deliberately never auto-absorbed —
// putting a customer 60km away on whichever route happened to exist is
// exactly the bug that made this rewrite necessary — so they surface here
// with the two real ways out: draw a service area around them (the fix
// that also handles tomorrow), or put them on a one-off route today.
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

  const build = async () => {
    const lat = Number(depot.lat);
    const lng = Number(depot.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
      setError('Set where this route starts from first — use your location, drop a pin, or type the coordinates.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const area = nearestAreaFor(lat, lng, areas);
      const result = await api.buildRoute(token, {
        start_lat: lat,
        start_lng: lng,
        name: name.trim() || (area ? `${area.name} route` : 'Extra route'),
        order_ids: stops.map((stop) => stop.id),
        date: date || undefined,
      });
      await onDone(`Route built with ${result.stops.length} stops.`);
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
        These deliveries have a pin but sit outside every service area, so no route covers them. The lasting fix is
        to add a service area around them on the Business tab — then they get their own route every day. To handle
        just today, build a one-off route for them here.
      </Text>

      {stops.slice(0, 5).map((stop) => (
        <Text key={stop.id} style={styles.strayLine}>
          {stop.customer_name}
          {stop.customer_address ? ` · ${stop.customer_address}` : ''}
        </Text>
      ))}
      {stops.length > 5 ? <Text style={styles.strayLine}>…and {stops.length - 5} more</Text> : null}

      <Disclosure open={expanded} onToggle={() => setExpanded((prev) => !prev)}>
        Build a one-off route for these
      </Disclosure>

      {expanded ? (
        <View>
          <Banner message={error} />
          <Field label="Route name" size="md" value={name} onChangeText={setName} placeholder="Extra route" />
          <LocationPicker
            label="Where does this route start?"
            lat={Number(depot.lat) || 0}
            lng={Number(depot.lng) || 0}
            onChange={(lat, lng) => setDepot({ lat: lat.toFixed(6), lng: lng.toFixed(6) })}
            home={home}
            areas={areas}
          />
          <Button title={`Build a route for these ${stops.length}`} onPress={build} busy={busy} style={styles.spaced} />
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
  modeRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  modeButton: { flex: 1, minWidth: 130 },
});
