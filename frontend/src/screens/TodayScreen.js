import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import AreaRoutesCard, { LooseRouteCard } from '../AreaRoutesCard';
import CheckinQueue from '../CheckinQueue';
import { Banner, Card, Empty, SectionTitle, ViewToggle } from '../components';
import DateNav from '../DateNav';
import DayRouteMapPanel from '../DayRouteMapPanel';
import DonutChart from '../DonutChart';
import { labelsFor, lower } from '../labels';
import { nearestAreaFor, serviceRouteOfRoute } from '../serviceAreas';
import NotGoingOut from '../NotGoingOut';
import { colors, spacing } from '../theme';

// The admin's whole day, on one screen.
//
// There is no separate Routes screen any more. Rounds are prepared
// automatically for every service area that has work (see
// ensureDayRounds), so the only decision left is who is driving — which
// is what AreaRoundsCard asks, and what the split falls out of. What the
// Routes tab uniquely had beyond that was the stops outside every area
// (NotGoingOut, below) and a handful of rare destructive actions, which
// now live behind each route's options button.
export default function TodayScreen({ token, business }) {
  const labels = labelsFor(business);
  const [day, setDay] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const [products, setProducts] = useState([]);
  const [areas, setAreas] = useState([]);
  const [checkins, setCheckins] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState('');
  // The same day's routes, as cards or on a map — see ViewToggle.
  const [view, setView] = useState('list');

  // Empty means "the business's own today" — resolved server-side (see
  // resolveDate in httpapi/server.go) so a driver's phone or an admin's
  // laptop in a different timezone can never disagree with the business
  // about what day it is. Only set to a concrete YYYY-MM-DD once the
  // admin actually navigates away from today.
  const [selectedDate, setSelectedDate] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [dayResponse, driverResponse, productResponse, areaResponse, checkinResponse] = await Promise.all([
        api.getDay(token, selectedDate || undefined),
        api.listDrivers(token),
        api.listProducts(token),
        api.listServiceAreas(token),
        api.listCheckins(token, selectedDate || undefined),
      ]);
      setDay(dayResponse);
      setDrivers(driverResponse.drivers || []);
      setProducts(productResponse.products || []);
      setAreas(areaResponse.service_areas || []);
      setCheckins(checkinResponse.checkins || []);
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

  // Re-optimizes each of an area's routes from its own stored start point,
  // keeping its name and its driver. A "re-order" picks up stops added
  // since the route was last built and reorders them; it must never
  // rename or reassign anything, which is what makes it safe to offer as
  // a plain option rather than a form.
  const rebuildArea = async (areaRoutes) => {
    if (!areaRoutes || areaRoutes.length === 0) {
      return;
    }
    setBusyAction(`rebuild-${areaRoutes[0].id}`);
    setError('');
    setNotice('');
    try {
      let total = 0;
      for (const route of areaRoutes) {
        const result = await api.buildRoute(token, {
          start_lat: route.start_lat,
          start_lng: route.start_lng,
          name: route.name,
          route_id: route.id,
          date: selectedDate || undefined,
        });
        total += result.stops.length;
      }
      setNotice(`Re-ordered ${total} stops.`);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyAction('');
    }
  };

  // Deleting an area's routes puts its deliveries back on the unassigned
  // list. They are not lost — the next day read prepares the area again,
  // which is why this is worded as clearing rather than deleting.
  const clearArea = async (areaRoutes) => {
    if (!areaRoutes || areaRoutes.length === 0) {
      return;
    }
    setError('');
    setNotice('');
    try {
      for (const route of areaRoutes) {
        await api.deleteRoute(token, route.id);
      }
      setNotice(`${labels.route} cleared. Its deliveries are back on the unassigned list.`);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  if (loading) {
    return <ActivityIndicator style={styles.loader} color={colors.accent} />;
  }

  const summary = day?.summary || {};
  const routes = day?.routes || [];
  const allStops = day?.stops || [];
  const home = business.home_lat || business.home_lng ? { lat: business.home_lat, lng: business.home_lng } : null;

  // Routes belong to the service route they were prepared for — the
  // same test the backend uses to recognise them (see serviceRouteOf in
  // admin.go, mirrored by serviceRouteOfRoute). One service route can
  // hold several, which is what splitting between drivers produces,
  // so this is a list per service route rather than one route each.
  const routesByArea = new Map(areas.map((area) => [area.id, []]));
  const looseRoutes = [];
  for (const route of routes) {
    const area = serviceRouteOfRoute(route, areas);
    if (area && routesByArea.has(area.id)) {
      routesByArea.get(area.id).push(route);
    } else {
      looseRoutes.push(route);
    }
  }
  const workingAreas = areas.filter((area) => (routesByArea.get(area.id) || []).length > 0);

  // Deliveries with a pin that no service area covers — the one case the
  // automatic preparation deliberately refuses to guess at. Same test
  // NotGoingOut groups by, so the count in the banner and the count in
  // the card can never disagree.
  const strays = allStops.filter(
    (stop) =>
      stop.status === 'pending' &&
      !stop.route_id &&
      (stop.lat || stop.lng) &&
      !nearestAreaFor(stop.lat, stop.lng, areas),
  );

  // What actually needs the admin this morning, in the order it matters.
  // Everything else on this screen is reassurance; this is the only part
  // that is a task.
  const needsDriver = workingAreas.filter((area) =>
    (routesByArea.get(area.id) || []).some((route) => !route.driver_id),
  );
  const exceptions = [];
  if (needsDriver.length > 0) {
    exceptions.push(
      needsDriver.length === 1
        ? `${needsDriver[0].name} has nobody driving it yet.`
        : `${needsDriver.length} ${lower(labels.route)}s have nobody driving them yet.`,
    );
  }
  if (strays.length > 0) {
    exceptions.push(
      `${strays.length} ${strays.length === 1 ? 'delivery is' : 'deliveries are'} not on any service ${lower(labels.route)}.`,
    );
  }
  if (summary.unpinned > 0) {
    // Written out, like every other line in this list. "customer(s)" is
    // the one place the app made the reader do the grammar, and it sat
    // on the first screen a new business sees.
    exceptions.push(
      summary.unpinned === 1
        ? `1 ${lower(labels.customer)} has no map pin, so they can't be routed.`
        : `${summary.unpinned} ${lower(labels.customer_plural)} have no map pin, so they can't be routed.`,
    );
  }
  // Every stop with a pin, routed or not — the map is for verifying the
  // whole day's assignment, so an unrouted stop has to be visible on it
  // too. See DayRouteMapPanel.
  const mappableStops = allStops.filter((stop) => stop.lat || stop.lng);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Banner message={error} />
      <Banner message={notice} tone="success" />

      {/* Above everything: a driver standing at the farm cannot wait, and
          everything else on this screen can. */}
      <CheckinQueue
        token={token}
        checkins={checkins}
        drivers={drivers}
        date={selectedDate}
        onChanged={refresh}
      />

      <Card>
        <DateNav date={day?.date} selectedDate={selectedDate} onSelect={setSelectedDate} />
        <View style={styles.chartRow}>
          <DonutChart
            total={summary.total ?? 0}
            segments={[
              { label: 'Pending', value: summary.pending ?? 0, color: colors.subtitle },
              { label: 'Delivered', value: summary.delivered ?? 0, color: colors.success },
              { label: 'Failed', value: summary.failed ?? 0, color: colors.error },
              { label: 'Skipped', value: summary.skipped ?? 0, color: colors.warning },
            ]}
          />
        </View>
        {/* The morning in one line. Rounds prepare themselves, so the
            only thing worth leading with is whether anything is waiting
            on a human — and on a normal day, that it isn't. */}
        {exceptions.length === 0 ? (
          <Banner tone="success" message="Everything's covered." />
        ) : (
          exceptions.map((line) => <Banner key={line} tone="info" message={line} />)
        )}

        <View style={styles.routesSection}>
          <SectionTitle
            right={
              mappableStops.length > 0 ? (
                <ViewToggle
                  value={view}
                  onChange={setView}
                  options={[
                    { value: 'list', label: 'List' },
                    { value: 'map', label: 'Map' },
                  ]}
                />
              ) : null
            }
          >
            {labels.route}s ({routes.length})
          </SectionTitle>
          {view === 'map' ? (
            <DayRouteMapPanel
              token={token}
              stops={mappableStops}
              routes={routes}
              drivers={drivers}
              home={home}
              labels={labels}
              onChanged={refresh}
            />
          ) : routes.length === 0 ? (
            <Empty>
              {areas.length === 0
                ? `A ${lower(labels.route)} is prepared for each service ${lower(labels.route)} you set up, and you have none yet — start on the Business tab.`
                : summary.total === 0
                  ? 'Nothing to deliver on this day.'
                  : `Nothing routed yet. ${labels.route}s are prepared for each service ${lower(labels.route)} that has deliveries in it.`}
            </Empty>
          ) : (
            <View>
              {workingAreas.map((area) => (
                <AreaRoutesCard
                  key={area.id}
                  token={token}
                  area={area}
                  labels={labels}
                  routes={routesByArea.get(area.id)}
                  stops={allStops}
                  drivers={drivers}
                  home={home}
                  products={products}
                  date={selectedDate}
                  onChanged={refresh}
                  onError={setError}
                  onRebuild={() => rebuildArea(routesByArea.get(area.id))}
                  rebuilding={busyAction === `rebuild-${area.id}`}
                  onDelete={() => clearArea(routesByArea.get(area.id))}
                />
              ))}
              {looseRoutes.map((route) => (
                <LooseRouteCard
                  key={route.id}
                  route={route}
                  labels={labels}
                  stops={allStops}
                  drivers={drivers}
                  home={home}
                  areas={areas}
                  products={products}
                  token={token}
                  onChanged={refresh}
                  onError={setError}
                  onDelete={() => clearArea([route])}
                />
              ))}
            </View>
          )}
          {view === 'list' ? (
            <Text style={styles.note}>
              One {lower(labels.route)} per service {lower(labels.route)}, prepared for every day automatically. Tell it who is driving and it splits
              itself between them.
            </Text>
          ) : null}
        </View>
      </Card>

      <NotGoingOut
        token={token}
        stops={allStops}
        areas={areas}
        home={home}
        date={selectedDate}
        products={products}
        labels={labels}
        onChanged={refresh}
        onError={setError}
        onNotice={async (message) => {
          setNotice(message);
          await refresh();
        }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, maxWidth: 720, width: '100%', alignSelf: 'center' },
  loader: { marginTop: spacing.xl * 2 },
  chartRow: { marginBottom: spacing.md },
  note: { fontSize: 12, color: colors.hint, marginTop: spacing.sm, lineHeight: 17 },
  routesSection: { marginTop: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.lg },
});
