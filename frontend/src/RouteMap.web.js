import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { colors, radius, spacing } from './theme';

// Every drop point for a day on one map, coloured by which round it is
// on, so an admin can see the split rather than read it as a list of
// names. A partition that looks sensible in numbers ("6, 6, 6, 4") can
// still be obviously wrong on a map — two rounds interleaved down the
// same street, or one stop stranded across a river — and that is the
// thing this view exists to catch.
//
// Tap a pin to select it; the caller renders the "move to another round"
// control (see RouteMap's onSelect and the picker in RoutesScreen), which
// keeps the map about geography and leaves the acting-on-it to normal
// form controls that already match the rest of the app.

// Ten colours, one per possible round (see maxPlannedRounds in the
// backend). Chosen to stay distinguishable next to each other on a pale
// map — the whole point is telling two adjacent rounds apart at a glance.
// Unrouted stops deliberately get none of these: they are grey, which
// reads as "not assigned" rather than as an eleventh round.
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
// carries the stop's position in its round — which is what makes "why is
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

export default function RouteMap({ stops, routes, home, selectedStopId, onSelect, height = 420 }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const fittedRef = useRef(false);

  // Read through refs inside the marker effect so redrawing markers never
  // depends on identity of the callback the caller happened to pass.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

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

    if (home) {
      L.circleMarker([home.lat, home.lng], {
        radius: 8,
        color: '#111',
        weight: 3,
        fillColor: '#fff',
        fillOpacity: 1,
      })
        .bindTooltip('Start', { direction: 'top' })
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
      const roundName = routes.find((route) => route.id === stop.route_id)?.name || 'Not on a round';
      marker.bindTooltip(`${stop.customer_name} — ${roundName}`, { direction: 'top' });
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
  }, [stops, routes, home, selectedStopId]);

  const routeIds = routes.map((route) => route.id);
  const hasUnrouted = stops.some((stop) => !stop.route_id && (stop.lat || stop.lng));

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
            <Text style={styles.legendLabel}>Not on a round</Text>
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
  legendLabel: { fontSize: 13, color: colors.label, fontWeight: '600' },
});
