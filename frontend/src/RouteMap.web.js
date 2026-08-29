import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { driverIcon, homeIcon } from './mapIcons';
import { colors, radius, spacing } from './theme';

// Every drop point for a day on one map, coloured by which route it is
// on, so an admin can see the split rather than read it as a list of
// names. A partition that looks sensible in numbers ("6, 6, 6, 4") can
// still be obviously wrong on a map — two routes interleaved down the
// same street, or one stop stranded across a river — and that is the
// thing this view exists to catch.
//
// Tap a pin to select it; the caller renders the "move to another route"
// control (see RouteMap's onSelectStop and the picker in RoutesScreen),
// which keeps the map about geography and leaves the acting-on-it to
// normal form controls that already match the rest of the app.
//
// The business's own location and every driver's finishing point are
// drawn too, muted, so an admin checking the day's split can still see
// "there's a driver who lives right by this cluster" without those
// markers competing with the coloured stops that are the actual subject
// of this map. Tapping one of them is read-only — see onSelectOther —
// because moving a driver's home or the business's depot from inside a
// route-planning map would be the wrong screen for that decision.
const MUTED_OPACITY = 0.4;

// Ten colours, one per possible route (see maxPlannedRoutes in the
// backend). Chosen to stay distinguishable next to each other on a pale
// map — the whole point is telling two adjacent routes apart at a glance.
// Unrouted stops deliberately get none of these: they are grey, which
// reads as "not assigned" rather than as an eleventh route.
const ROUTE_COLORS = [
  '#2f6f4e', // green
  '#1f5f8b', // blue
  '#8b3a2f', // rust
  '#6b4c9a', // purple
  '#b07c14', // amber
  '#207e7e', // teal
  '#96305f', // magenta
  '#4b5d2a', // olive
  '#8a5a2b', // brown
  '#3d4a6b', // slate
];
const UNROUTED_COLOR = '#98a2b3';

export function colorForRoute(routeId, routeIds) {
  const index = routeIds.indexOf(routeId);
  if (routeId == null || routeId === '' || index < 0) {
    return UNROUTED_COLOR;
  }
  return ROUTE_COLORS[index % ROUTE_COLORS.length];
}

// A numbered dot rather than a teardrop pin: at 40-odd stops the pins
// overlap into a wall of shapes, while dots stay readable and the number
// carries the stop's position in its route — which is what makes "why is
// 12 way over there?" answerable from the map alone.
function markerIcon(color, label, selected) {
  const size = selected ? 30 : 24;
  const svg = encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
      `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 2}" fill="${color}" ` +
      `stroke="${selected ? '#111' : '#fff'}" stroke-width="${selected ? 3 : 2}"/>` +
      `<text x="${size / 2}" y="${size / 2 + 4}" text-anchor="middle" ` +
      `font-family="system-ui,sans-serif" font-size="11" font-weight="700" fill="#fff">${label}</text>` +
      `</svg>`
  );
  return L.icon({
    iconUrl: `data:image/svg+xml,${svg}`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

export default function RouteMap({
  stops,
  routes,
  home,
  drivers = [],
  selectedStopId,
  onSelect,
  onSelectOther,
  height = 420,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const fittedRef = useRef(false);

  // Read through refs inside the marker effect so redrawing markers never
  // depends on identity of the callback the caller happened to pass.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onSelectOtherRef = useRef(onSelectOther);
  onSelectOtherRef.current = onSelectOther;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return undefined;
    }
    const map = L.map(containerRef.current, {
      center: [20.5937, 78.9629],
      zoom: 5,
      // Leaflet's default wheel zoom steps a whole zoom level per tick,
      // which on a trackpad means one flick crosses four or five levels
      // and the map is suddenly showing a different state. Smaller steps
      // and a little debounce make it land where you meant.
      wheelPxPerZoomLevel: 240,
      wheelDebounceTime: 60,
      zoomSnap: 0.5,
      zoomDelta: 0.5,
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  // Markers are rebuilt whenever the stops or the selection change.
  // Rebuilding the whole layer rather than diffing it is the version that
  // is obviously correct, and forty-odd circle markers is nothing.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    if (layerRef.current) {
      layerRef.current.remove();
    }

    const routeIds = routes.map((route) => route.id);
    const layer = L.featureGroup();

    // Context, not the subject of this map: drawn muted, and tapping one
    // opens a read-only card rather than anything editable — see the
    // header comment above for why.
    for (const driver of drivers || []) {
      if (!driver.home_lat && !driver.home_lng) {
        continue;
      }
      L.marker([driver.home_lat, driver.home_lng], { icon: driverIcon, opacity: MUTED_OPACITY })
        .bindTooltip(`${driver.name} finishes here`, { direction: 'top' })
        .on('click', () => onSelectOtherRef.current?.({ kind: 'driver', data: driver }))
        .addTo(layer);
    }

    if (home) {
      L.marker([home.lat, home.lng], { icon: homeIcon, opacity: MUTED_OPACITY })
        .bindTooltip('Your business', { direction: 'top' })
        .on('click', () => onSelectOtherRef.current?.({ kind: 'business', data: home }))
        .addTo(layer);
    }

    for (const stop of stops) {
      if (!stop.lat && !stop.lng) {
        continue;
      }
      const color = colorForRoute(stop.route_id, routeIds);
      const label = stop.sequence > 0 ? String(stop.sequence) : '·';
      const marker = L.marker([stop.lat, stop.lng], {
        icon: markerIcon(color, label, stop.id === selectedStopId),
        // Selected marker on top, so it can't hide under a neighbour.
        zIndexOffset: stop.id === selectedStopId ? 1000 : 0,
      });
      const routeName = routes.find((route) => route.id === stop.route_id)?.name || 'Not on a route';
      marker.bindTooltip(`${stop.customer_name} — ${routeName}`, { direction: 'top' });
      marker.on('click', () => onSelectRef.current(stop));
      marker.addTo(layer);
    }

    layer.addTo(map);
    layerRef.current = layer;

    // Fit once, on the first render that actually has something to fit.
    // Re-fitting on every change would yank the map back to the whole
    // day every time an admin moved one stop, undoing their zoom.
    if (!fittedRef.current) {
      const bounds = layer.getBounds();
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [30, 30] });
        fittedRef.current = true;
      }
    }
  }, [stops, routes, home, drivers, selectedStopId]);

  const routeIds = routes.map((route) => route.id);
  const hasUnrouted = stops.some((stop) => !stop.route_id && (stop.lat || stop.lng));
  const hasDrivers = (drivers || []).some((driver) => driver.home_lat || driver.home_lng);

  return (
    <View>
      <View ref={containerRef} style={[styles.map, { height }]} />
      <View style={styles.legend}>
        {routes.map((route) => (
          <View key={route.id} style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: colorForRoute(route.id, routeIds) }]} />
            <Text style={styles.legendLabel}>{route.name}</Text>
          </View>
        ))}
        {hasUnrouted ? (
          <View style={styles.legendItem}>
            <View style={[styles.swatch, { backgroundColor: UNROUTED_COLOR }]} />
            <Text style={styles.legendLabel}>Not on a route</Text>
          </View>
        ) : null}
        {home ? (
          <View style={styles.legendItem}>
            <View style={[styles.swatch, styles.mutedSwatch, styles.keyHome]} />
            <Text style={styles.legendLabel}>Your business</Text>
          </View>
        ) : null}
        {hasDrivers ? (
          <View style={styles.legendItem}>
            <View style={[styles.swatch, styles.mutedSwatch, styles.keyDriver]} />
            <Text style={styles.legendLabel}>Driver</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  map: {
    width: '100%',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    marginBottom: spacing.sm,
  },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginBottom: spacing.sm },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  swatch: { width: 12, height: 12, borderRadius: 6 },
  mutedSwatch: { opacity: MUTED_OPACITY },
  keyHome: { backgroundColor: colors.text, borderRadius: 2 },
  keyDriver: { backgroundColor: colors.accent },
  legendLabel: { fontSize: 13, color: colors.label, fontWeight: '600' },
});
