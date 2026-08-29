import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { activePinIcon, customerIcon, driverIcon, homeIcon } from './mapIcons';
import { colors, radius, spacing } from './theme';

// The pin being placed right now. Every other symbol on this map (the
// business, drivers, customers) comes from mapIcons.js so the whole app
// draws them the same way.
const pinIcon = activePinIcon;

// Center used only before any pin exists on this record — purely
// cosmetic, since the first click replaces it immediately.
const DEFAULT_CENTER = [20.5937, 78.9629]; // roughly the center of India

// Click-to-place, drag-to-adjust pin. Fires onChange(lat, lng) on every
// placement/drag — the caller decides whether that means "update local
// form state" (new customer) or "save immediately" (editing an existing
// one), matching how the existing "pin my current location" buttons
// already behave.
//
// Three optional props scope the map to a business's own operating area
// instead of the India-wide fallback below:
//   - home: {lat, lng} | null — the business's own depot/shop location.
//   - areas: [{lat, lng, radius_meters, active}] — its declared service
//     areas, each drawn as a translucent circle.
//   - previewRadiusMeters: number | null — draws (and live-updates) a
//     circle around the *current* pin, for the "add a service area" flow
//     where an admin is picking a radius and wants to see it as they type.
export default function MapPicker({
  lat,
  lng,
  onChange,
  height = 260,
  home = null,
  areas = [],
  drivers = [],
  customers = [],
  previewRadiusMeters = null,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const previewCircleRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Read at mount time only (see the mount effect below) — home/areas
  // drive a one-time "fit the default view" and a static reference layer,
  // not something that should re-fit the map out from under an admin
  // who's mid-drag because a sibling list re-rendered.
  const homeRef = useRef(home);
  homeRef.current = home;
  const areasRef = useRef(areas);
  areasRef.current = areas;
  const driversRef = useRef(drivers);
  driversRef.current = drivers;
  const customersRef = useRef(customers);
  customersRef.current = customers;

  const placeMarker = (map, latlng) => {
    if (markerRef.current) {
      markerRef.current.setLatLng(latlng);
      return;
    }
    markerRef.current = L.marker(latlng, { icon: pinIcon, draggable: true }).addTo(map);
    markerRef.current.on('dragend', () => {
      const pos = markerRef.current.getLatLng();
      onChangeRef.current(pos.lat, pos.lng);
    });
  };

  // Mounted once. Re-centering when lat/lng change from outside (typed
  // coordinates, "pin my current location") is handled by the effect
  // below rather than tearing the map down and rebuilding it.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return undefined;
    }

    const hasPin = Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0);
    const center = hasPin ? [lat, lng] : DEFAULT_CENTER;

    const map = L.map(containerRef.current, {
      center,
      zoom: hasPin ? 15 : 5,
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

    if (hasPin) {
      placeMarker(map, center);
    }

    // Reference layer: each service area as a translucent circle, the
    // business's own home location as a plain (non-draggable) marker.
    // Built once from the props this component happened to mount with —
    // see homeRef/areasRef above for why this isn't reactive.
    const referenceShapes = [];
    for (const area of areasRef.current || []) {
      if (area.active === false) {
        continue;
      }
      referenceShapes.push(
        L.circle([area.lat, area.lng], {
          radius: area.radius_meters,
          color: colors.subtitle,
          weight: 1,
          fillOpacity: 0.06,
        }).addTo(map)
      );
    }
    // Customers first, so the handful of markers that matter draw on top
    // of the hundred that are context.
    for (const customer of customersRef.current || []) {
      if (!customer.lat && !customer.lng) {
        continue;
      }
      referenceShapes.push(
        L.marker([customer.lat, customer.lng], { icon: customerIcon, interactive: true })
          .bindTooltip(customer.name, { direction: 'top' })
          .addTo(map)
      );
    }

    for (const driver of driversRef.current || []) {
      if (!driver.home_lat && !driver.home_lng) {
        continue;
      }
      referenceShapes.push(
        L.marker([driver.home_lat, driver.home_lng], { icon: driverIcon })
          .bindTooltip(`${driver.name} finishes here`, { direction: 'top' })
          .addTo(map)
      );
    }

    if (homeRef.current) {
      referenceShapes.push(
        L.marker([homeRef.current.lat, homeRef.current.lng], { icon: homeIcon })
          .bindTooltip('Your business', { direction: 'top' })
          .addTo(map)
      );
    }

    // No pin yet, but there's a home/service area to scope the default
    // view to — fit those bounds instead of the India-wide fallback
    // above. This is the fix for "zoom in/out over a vast area": a
    // business that has set up where it operates never has to re-find
    // itself on the map by hand.
    if (!hasPin && referenceShapes.length > 0) {
      const group = L.featureGroup(referenceShapes);
      map.fitBounds(group.getBounds(), { padding: [20, 20] });
    }

    map.on('click', (event) => {
      placeMarker(map, event.latlng);
      onChangeRef.current(event.latlng.lat, event.latlng.lng);
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      previewCircleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the marker in sync when lat/lng arrive from outside the map
  // itself (typed coordinates, "pin my current location"). Guarded
  // against re-applying the map's own just-fired click/drag position.
  //
  // Also keeps the live radius-preview circle (see previewRadiusMeters
  // above) in sync — with the pin as it moves, and with the radius field
  // as the caller types into it. That second half is deliberately not
  // gated behind the "did the pin actually move" guard below: the pin
  // can be perfectly still while the admin is only changing the number.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const hasPin = Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0);

    if (hasPin) {
      const current = markerRef.current?.getLatLng();
      const moved = !current || Math.abs(current.lat - lat) >= 1e-9 || Math.abs(current.lng - lng) >= 1e-9;
      if (moved) {
        placeMarker(map, [lat, lng]);
        map.setView([lat, lng], Math.max(map.getZoom(), 14));
      }
    }

    if (hasPin && previewRadiusMeters) {
      if (previewCircleRef.current) {
        previewCircleRef.current.setLatLng([lat, lng]);
        previewCircleRef.current.setRadius(previewRadiusMeters);
      } else {
        previewCircleRef.current = L.circle([lat, lng], {
          radius: previewRadiusMeters,
          color: colors.accent,
          weight: 2,
          fillOpacity: 0.08,
        }).addTo(map);
      }
    } else if (previewCircleRef.current) {
      previewCircleRef.current.remove();
      previewCircleRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng, previewRadiusMeters]);

  const showLegend = !!home || (drivers || []).some((d) => d.home_lat || d.home_lng) || (customers || []).length > 0;

  return (
    <View>
      <View ref={containerRef} style={[styles.map, { height }]} />
      {showLegend ? <MapLegend home={home} drivers={drivers} customers={customers} areas={areas} /> : null}
    </View>
  );
}

// What the symbols mean. Drawn as small CSS shapes rather than reusing
// the SVG icons at a smaller size — a 14px house is a smudge, whereas a
// square, a circle and a ring stay legible and still map one-to-one onto
// what's on the map above.
function MapLegend({ home, drivers, customers, areas }) {
  const items = [];
  if (home) {
    items.push({ key: 'home', label: 'Your business', style: styles.keyHome });
  }
  if ((drivers || []).some((d) => d.home_lat || d.home_lng)) {
    items.push({ key: 'driver', label: 'Driver finishes here', style: styles.keyDriver });
  }
  if ((customers || []).length > 0) {
    items.push({ key: 'customer', label: 'Customer', style: styles.keyCustomer });
  }
  if ((areas || []).some((a) => a.active !== false)) {
    items.push({ key: 'area', label: 'Service area', style: styles.keyArea });
  }

  return (
    <View style={styles.legend}>
      {items.map((item) => (
        <View key={item.key} style={styles.legendItem}>
          <View style={[styles.keyBase, item.style]} />
          <Text style={styles.legendLabel}>{item.label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  map: {
    borderRadius: radius.md,
    overflow: 'hidden',
    marginTop: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.xs, marginBottom: spacing.sm },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  legendLabel: { fontSize: 12, color: colors.subtitle, fontWeight: '600' },
  keyBase: { width: 12, height: 12 },
  keyHome: { backgroundColor: colors.text, borderRadius: 2 },
  keyDriver: { backgroundColor: colors.accent, borderRadius: 6 },
  keyCustomer: { backgroundColor: colors.subtitle, borderRadius: 6, width: 8, height: 8 },
  keyArea: { borderWidth: 2, borderColor: colors.subtitle, borderRadius: 6, backgroundColor: 'transparent' },
});
