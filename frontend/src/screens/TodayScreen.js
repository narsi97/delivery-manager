import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import * as api from '../api';
import { Banner, Card, Empty, SectionTitle } from '../components';
import DateNav from '../DateNav';
import DayRouteMapCard from '../DayRouteMapCard';
import DonutChart from '../DonutChart';
import { RouteSummary, UnassignedDeliveries } from '../routeCards';
import { colors, spacing } from '../theme';

// The admin's daily status screen: what's happening on a given day, and
// the routes already built for it — assign a driver, rebuild one to pick
// up newly-added stops, or drill into its deliveries. Building a *new*
// route from scratch lives on its own Routes screen (see
// RoutesScreen.js); this page is for reviewing and managing what already
// exists, so an admin glancing at it mid-shift sees the day's actual
// state, not a route-creation form.
export default function TodayScreen({ token, business }) {
  const [day, setDay] = useState(null);
  const [drivers, setDrivers] = useState([]);
  const [products, setProducts] = useState([]);
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
      const [dayResponse, driverResponse, productResponse] = await Promise.all([
        api.getDay(token, selectedDate || undefined),
        api.listDrivers(token),
        api.listProducts(token),
      ]);
      setDay(dayResponse);
      setDrivers(driverResponse.drivers || []);
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

  // Re-optimizes from the route's own stored start point (set whenever
  // it was first built) and keeps its existing name — a "rebuild" should
  // pick up newly-eligible stops and reorder, not silently rename or
  // relocate the route. That's what makes this safe to offer here with
  // no route-building form on this page at all.
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
      setNotice(`${route.name}: rebuilt with ${result.stops.length} stops.`);
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

  const summary = day?.summary || {};
  const routes = day?.routes || [];
  const home = business.home_lat || business.home_lng ? { lat: business.home_lat, lng: business.home_lng } : null;
  // Same map RoutesScreen offers — Today is a second lens on the same
  // day, not a different feature, so the two must never quietly drift
  // apart. See DayRouteMapCard's own comment.
  const mappableStops = (day?.stops || []).filter((stop) => stop.lat || stop.lng);

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
        <Banner
          tone="info"
          message={
            summary.unpinned > 0
              ? `${summary.unpinned} customer(s) have no map pin yet, so they can't be routed.`
              : ''
          }
        />

        <View style={styles.routesSection}>
          <SectionTitle>Routes ({routes.length})</SectionTitle>
          {routes.length === 0 ? (
            <Empty>No route built yet for this day. Build one on the Routes tab.</Empty>
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
        </View>

        <UnassignedDeliveries
          stops={(day?.stops || []).filter((stop) => !stop.route_id)}
          products={products}
          token={token}
          onChanged={refresh}
          onError={setError}
        />
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, maxWidth: 720, width: '100%', alignSelf: 'center' },
  loader: { marginTop: spacing.xl * 2 },
  chartRow: { marginBottom: spacing.md },
  routesSection: { marginTop: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.lg },
});
