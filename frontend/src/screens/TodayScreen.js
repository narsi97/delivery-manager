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
import { serviceRouteOfRoute } from '../serviceAreas';
import { CauseStops, notGoingOutCauses, OneOffRoute } from '../NotGoingOut';
import { usePageStyle } from '../layout';
import ProductTable from '../ProductTable';
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
  const pageStyle = usePageStyle(720);
  const labels = labelsFor(business);
  const [day, setDay] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const [products, setProducts] = useState([]);
  // What the day being shown adds up to, per product. Asked for the
  // selected date rather than today's, so somebody looking at tomorrow
  // is told what tomorrow needs — which is the whole reason this
  // question moved off the Business page (see the comment there).
  const [demand, setDemand] = useState({});
  // What is in the cold room on the day being shown. Absent means none:
  // every date starts empty and fills when the churns come in.
  const [stock, setStock] = useState({});
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
      const [dayResponse, driverResponse, productResponse, areaResponse, checkinResponse, demandResponse] =
        await Promise.all([
          api.getDay(token, selectedDate || undefined),
          api.listDrivers(token),
          api.listProducts(token),
          api.listServiceAreas(token),
          api.listCheckins(token, selectedDate || undefined),
          api.getProductDemand(token, selectedDate || undefined),
        ]);
      setDay(dayResponse);
      setDrivers(driverResponse.drivers || []);
      setProducts(productResponse.products || []);
      setDemand(demandResponse.needed || {});
      setStock(demandResponse.stock || {});
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

  // What actually needs the admin this morning, in the order it matters.
  // Everything else on this screen is reassurance; this is the only part
  // that is a task.
  const needsDriver = workingAreas.filter((area) =>
    (routesByArea.get(area.id) || []).some((route) => !route.driver_id),
  );
  // Each warning is one reason, said once, and opens onto the very
  // deliveries it is about — rather than naming a problem and leaving
  // the reader to scroll past the whole round to find it again under a
  // second heading. See Docs/DESIGN.md and notGoingOutCauses.
  const causes = notGoingOutCauses(allStops, areas);

  // What is missing, rather than a sentence about what that means. Each
  // of these was a line of explanation read every morning — "we don't
  // know where some of them lives, so they can't be put in order" — and
  // an explanation on its third reading is furniture. The count is on
  // the badge, the deliveries are one press away, and the label is the
  // two words that say which of them to open. Docs/DESIGN.md, rule 1.
  //
  // Two states, not one, and the same two the day's table colours: a
  // door with an address but no pin can still be driven to, and a door
  // with neither cannot be found at all.
  const noPin = allStops.filter((stop) => stop.status === 'pending' && !stop.lat && !stop.lng);
  const needsAddress = noPin.filter((stop) => !(stop.customer_address || '').trim());
  const needsCoordinates = noPin.filter((stop) => (stop.customer_address || '').trim());

  const exceptions = [];
  if (needsDriver.length > 0) {
    exceptions.push({
      key: 'no-driver',
      count: needsDriver.length,
      message: `Needs a ${lower(labels.driver)}`,
    });
  }
  if (needsAddress.length > 0) {
    exceptions.push({
      key: 'needs-address',
      count: needsAddress.length,
      message: 'Needs address',
      stops: needsAddress,
    });
  }
  if (needsCoordinates.length > 0) {
    exceptions.push({
      key: 'needs-coordinates',
      count: needsCoordinates.length,
      message: 'Needs coordinates',
      stops: needsCoordinates,
    });
  }
  if (causes.outside.length > 0) {
    exceptions.push({
      key: 'outside',
      count: causes.outside.length,
      message: `Outside every service ${lower(labels.route)}`,
      stops: causes.outside,
      // The one cause with a fix that is not per-customer: a round built
      // for today only, so they go out while the area gets sorted.
      extra: (
        <OneOffRoute
          token={token}
          stops={causes.outside}
          areas={areas}
          home={home}
          date={selectedDate}
          labels={labels}
          onDone={async (message) => {
            setNotice(message);
            await refresh();
          }}
        />
      ),
    });
  }
  if (causes.waiting.length > 0) {
    exceptions.push({
      key: 'waiting',
      count: causes.waiting.length,
      message: `Waiting for a ${lower(labels.route)}`,
      stops: causes.waiting,
    });
  }
  // Not enough in the cold room for what this day is asking for.
  //
  // This used to be a column on the Business page, which could only ever
  // answer it about today — and a business looks at tomorrow the night
  // before. Here it follows the date picker, and opens onto the table
  // where the stock number is changed.
  const shortSizes = products
    .map((product) => ({
      name: product.name,
      short: Math.max(0, (demand[product.id] || 0) - (Number(stock[product.id]) || 0)),
    }))
    .filter((line) => line.short > 0)
    .sort((a, b) => b.short - a.short);
  if (shortSizes.length > 0) {
    exceptions.push({
      key: 'short-stock',
      count: shortSizes.length,
      message: 'Needs restock',
      // The table itself, not a summary of it: the answer to being short
      // is to change the number, and it is right there to change.
      products: true,
    });
  }

  // Every stop with a pin, routed or not — the map is for verifying the
  // whole day's assignment, so an unrouted stop has to be visible on it
  // too. See DayRouteMapPanel.
  const mappableStops = allStops.filter((stop) => stop.lat || stop.lng);

  return (
    <ScrollView contentContainerStyle={pageStyle}>
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
          {/* Only what happened. Before a round goes out this reads
              91 / 0 / 0 / 0, spending three quarters of itself on things
              that have not occurred — and "0 failed" is worth saying
              only on a day that had some. Pending always shows, because
              on an untouched morning it is the whole story. See
              Docs/DESIGN.md. */}
          <DonutChart
            total={summary.total ?? 0}
            segments={[
              { label: 'Pending', value: summary.pending ?? 0, color: colors.subtitle },
              { label: 'Delivered', value: summary.delivered ?? 0, color: colors.success },
              { label: 'Failed', value: summary.failed ?? 0, color: colors.error },
              { label: 'Skipped', value: summary.skipped ?? 0, color: colors.warning },
            ].filter((segment) => segment.value > 0 || segment.label === 'Pending')}
          />
        </View>
        {/* The morning in one line. Rounds prepare themselves, so the
            only thing worth leading with is whether anything is waiting
            on a human — and on a normal day, that it isn't. */}
        {exceptions.length === 0 ? (
          <Banner tone="success" message="Everything's covered." />
        ) : (
          exceptions.map((exception) => (
            <Banner key={exception.key} tone="info" message={exception.message} count={exception.count}>
              {/* The banner body is already a white ground (see
                  Banner), so the table lands on the same surface it has
                  under Manage business. */}
              {exception.products ? (
                <ProductTable
                  products={products}
                  demand={demand}
                  stock={stock}
                  date={day?.date}
                  token={token}
                  onChanged={refresh}
                  onError={setError}
                />
              ) : null}
              {exception.stops ? (
                <CauseStops
                  stops={exception.stops}
                  products={products}
                  token={token}
                  home={home}
                  areas={areas}
                  onChanged={refresh}
                  onError={setError}
                >
                  {exception.extra}
                </CauseStops>
              ) : null}
            </Banner>
          ))
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
                ? `No service ${lower(labels.route)}s yet — set one up under Manage business.`
                : summary.total === 0
                  ? 'Nothing to deliver on this day.'
                  : `Nothing routed yet.`}
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
        </View>
      </Card>

      {/* Under the rounds, and only on a day that has enough of
          everything. Short, and it is up in the warnings instead, where
          something needing a decision belongs — the same table either
          way, so the numbers never move around under somebody's hands.
          See Docs/DESIGN.md, rule 4: show what is true. */}
      {products.length > 0 && shortSizes.length === 0 ? (
        <Card>
          <SectionTitle>Stock</SectionTitle>
          <View style={styles.headingDivider} />
          <ProductTable
            products={products}
            demand={demand}
            stock={stock}
            date={day?.date}
            token={token}
            onChanged={refresh}
            onError={setError}
          />
        </Card>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  headingDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginTop: -spacing.sm,
    marginBottom: spacing.md,
  },
  loader: { marginTop: spacing.xl * 2 },
  chartRow: { marginBottom: spacing.md },
  note: { fontSize: 12, color: colors.hint, marginTop: spacing.sm, lineHeight: 17 },
  routesSection: { marginTop: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.lg },
});
