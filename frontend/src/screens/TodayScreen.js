import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import AreaRoundsCard, { LooseRoundCard } from '../AreaRoundsCard';
import { Banner, Card, Empty, SectionTitle } from '../components';
import DateNav from '../DateNav';
import DayRouteMapCard from '../DayRouteMapCard';
import DonutChart from '../DonutChart';
import { UnassignedDeliveries } from '../routeCards';
import { nearestAreaFor } from '../serviceAreas';
import StrayStopsCard from '../StrayStopsCard';
import { colors, spacing } from '../theme';

// The admin's whole day, on one screen.
//
// There is no separate Routes screen any more. Rounds are prepared
// automatically for every service area that has work (see
// ensureDayRounds), so the only decision left is who is driving — which
// is what AreaRoundsCard asks, and what the split falls out of. What the
// Routes tab uniquely had beyond that was the stops outside every area
// (StrayStopsCard, below) and a handful of rare destructive actions,
// which now live behind each round's options button.
export default function TodayScreen({ token, business }) {
  const [day, setDay] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const [products, setProducts] = useState([]);
  const [areas, setAreas] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState('');

  // Empty means "the business's own today" — resolved server-side (see
  // resolveDate in httpapi/server.go) so a driver's phone or an admin's
  // laptop in a different timezone can never disagree with the business
  // about what day it is. Only set to a concrete YYYY-MM-DD once the
  // admin actually navigates away from today.
  const [selectedDate, setSelectedDate] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [dayResponse, driverResponse, productResponse, areaResponse] = await Promise.all([
        api.getDay(token, selectedDate || undefined),
        api.listDrivers(token),
        api.listProducts(token),
        api.listServiceAreas(token),
      ]);
      setDay(dayResponse);
      setDrivers(driverResponse.drivers || []);
      setProducts(productResponse.products || []);
      setAreas(areaResponse.service_areas || []);
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

  // Re-optimizes each of an area's rounds from its own stored start point,
  // keeping its name and its driver. A "re-order" picks up stops added
  // since the round was last built and reorders them; it must never
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

  // Deleting an area's rounds puts its deliveries back on the unassigned
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
      setNotice('Round cleared. Its deliveries are back on the unassigned list.');
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

  // Rounds belong to the area their start point sits in — the same test
  // the backend uses to recognise them (see areaContaining in admin.go,
  // mirrored by nearestAreaFor). A split area has several, which is why
  // this is a list per area rather than one route each.
  const roundsByArea = new Map(areas.map((area) => [area.id, []]));
  const looseRounds = [];
  for (const route of routes) {
    const area = nearestAreaFor(route.start_lat, route.start_lng, areas);
    if (area && roundsByArea.has(area.id)) {
      roundsByArea.get(area.id).push(route);
    } else {
      looseRounds.push(route);
    }
  }
  const workingAreas = areas.filter((area) => (roundsByArea.get(area.id) || []).length > 0);

  // Deliveries with a pin that no service area covers — the one case the
  // automatic preparation deliberately refuses to guess at.
  const strays = allStops.filter(
    (stop) => stop.status === 'pending' && !stop.route_id && (stop.lat || stop.lng)
  );

  // What actually needs the admin this morning, in the order it matters.
  // Everything else on this screen is reassurance; this is the only part
  // that is a task.
  const needsDriver = workingAreas.filter((area) =>
    (roundsByArea.get(area.id) || []).some((route) => !route.driver_id)
  );
  const exceptions = [];
  if (needsDriver.length > 0) {
    exceptions.push(
      needsDriver.length === 1
        ? `${needsDriver[0].name} has nobody driving it yet.`
        : `${needsDriver.length} rounds have nobody driving them yet.`
    );
  }
  if (strays.length > 0) {
    exceptions.push(
      `${strays.length} ${strays.length === 1 ? 'delivery is' : 'deliveries are'} outside every service area.`
    );
  }
  if (summary.unpinned > 0) {
    exceptions.push(`${summary.unpinned} customer(s) have no map pin, so they can't be routed.`);
  }
  // Every stop with a pin, routed or not — the map is for verifying the
  // whole day's assignment, so an unrouted stop has to be visible on it
  // too. See DayRouteMapCard.
  const mappableStops = allStops.filter((stop) => stop.lat || stop.lng);

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Banner message={error} />
      <Banner message={notice} tone="success" />

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
          <SectionTitle>Rounds ({routes.length})</SectionTitle>
          {routes.length === 0 ? (
            <Empty>
              Nothing to deliver here yet. Rounds are prepared automatically for each service area that has
              deliveries — add one on the Business tab.
            </Empty>
          ) : (
            <View>
              {workingAreas.map((area) => (
                <AreaRoundsCard
                  key={area.id}
                  token={token}
                  area={area}
                  routes={roundsByArea.get(area.id)}
                  stops={allStops}
                  drivers={drivers}
                  products={products}
                  date={selectedDate}
                  onChanged={refresh}
                  onError={setError}
                  onRebuild={() => rebuildArea(roundsByArea.get(area.id))}
                  rebuilding={busyAction === `rebuild-${area.id}`}
                  onDelete={() => clearArea(roundsByArea.get(area.id))}
                />
              ))}
              {looseRounds.map((route) => (
                <LooseRoundCard
                  key={route.id}
                  route={route}
                  stops={allStops}
                  drivers={drivers}
                  products={products}
                  token={token}
                  onChanged={refresh}
                  onError={setError}
                  onDelete={() => clearArea([route])}
                />
              ))}
            </View>
          )}
          <Text style={styles.note}>
            One round per service area, prepared for every day automatically. Tell it who is driving and it
            splits itself between them.
          </Text>
        </View>

        <UnassignedDeliveries
          stops={allStops.filter((stop) => !stop.route_id)}
          products={products}
          token={token}
          onChanged={refresh}
          onError={setError}
        />
      </Card>

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
