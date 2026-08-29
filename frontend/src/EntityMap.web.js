import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { customerIcon, driverIcon, homeIcon } from './mapIcons';
import { colors, radius, spacing } from './theme';

// Every location a business has, on one map: its own depot, every
// driver's finishing point, every customer's door. Only one *kind* is
// editable from wherever this is shown — customers on the Customers tab,
// drivers on the Drivers tab, either from the Business tab's own map —
// and the rest render muted with a read-only card on tap (see
// EntityCard.js), so an admin managing customers can still see "there's
// a driver who lives right near here" without being able to move them by
// mistake.
//
// Tap a pin to select it; the caller decides what that means — an
// editable location control for the one kind this screen owns, a
// read-only summary for everything else — same split RouteMap.web.js
// already uses for the day's route map.
const MUTED_OPACITY = 0.4;

export default function EntityMap({
  home,
  drivers = [],
  customers = [],
  areas = [],
  editableKind,
  selectedId,
  onSelect,
  height = 420,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const fittedRef = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return undefined;
    }
    const map = L.map(containerRef.current, {
      center: [20.5937, 78.9629],
      zoom: 5,
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

  // Markers are rebuilt whenever the entities or the selection change —
  // same "obviously correct over clever" call RouteMap.web.js makes, and
  // for the same reason: this is at most a few hundred markers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    if (layerRef.current) {
      layerRef.current.remove();
    }
    const layer = L.featureGroup();

    for (const area of areas || []) {
      if (area.active === false) {
        continue;
      }
      L.circle([area.lat, area.lng], {
        radius: area.radius_meters,
        color: colors.subtitle,
        weight: 1,
        fillOpacity: 0.06,
      }).addTo(layer);
    }

    // Customers first, so the smaller set of markers that matter on any
    // given screen draw on top of the potentially large one that's just
    // context — same ordering MapPicker.web.js already uses.
    for (const customer of customers || []) {
      if (!customer.lat && !customer.lng) {
        continue;
      }
      const isEditable = editableKind === 'customer';
      const isSelected = isEditable && selectedId === customer.id;
      L.marker([customer.lat, customer.lng], {
        icon: customerIcon,
        opacity: isEditable ? 1 : MUTED_OPACITY,
        zIndexOffset: isSelected ? 1000 : isEditable ? 500 : 0,
      })
        .bindTooltip(customer.name, { direction: 'top' })
        .on('click', () => onSelectRef.current({ kind: 'customer', data: customer }))
        .addTo(layer);
    }

    for (const driver of drivers || []) {
      if (!driver.home_lat && !driver.home_lng) {
        continue;
      }
      const isEditable = editableKind === 'driver';
      const isSelected = isEditable && selectedId === driver.id;
      L.marker([driver.home_lat, driver.home_lng], {
        icon: driverIcon,
        opacity: isEditable ? 1 : MUTED_OPACITY,
        zIndexOffset: isSelected ? 1000 : isEditable ? 500 : 0,
      })
        .bindTooltip(`${driver.name} finishes here`, { direction: 'top' })
        .on('click', () => onSelectRef.current({ kind: 'driver', data: driver }))
        .addTo(layer);
    }

    if (home) {
      const isEditable = editableKind === 'business';
      L.marker([home.lat, home.lng], {
        icon: homeIcon,
        opacity: isEditable ? 1 : MUTED_OPACITY,
        zIndexOffset: isEditable ? 500 : 0,
      })
        .bindTooltip('Your business', { direction: 'top' })
        .on('click', () => onSelectRef.current({ kind: 'business', data: home }))
        .addTo(layer);
    }

    layer.addTo(map);
    layerRef.current = layer;

    if (!fittedRef.current) {
      const bounds = layer.getBounds();
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [30, 30] });
        fittedRef.current = true;
      }
    }
  }, [home, drivers, customers, areas, editableKind, selectedId]);

  const hasDrivers = (drivers || []).some((driver) => driver.home_lat || driver.home_lng);
  const hasCustomers = (customers || []).some((customer) => customer.lat || customer.lng);
  const hasAreas = (areas || []).some((area) => area.active !== false);

  return (
    <View>
      <View ref={containerRef} style={[styles.map, { height }]} />
      <View style={styles.legend}>
        {home ? (
          <LegendItem
            label={editableKind === 'business' ? 'Your business (tap to edit)' : 'Your business'}
            swatch={styles.keyHome}
            muted={editableKind !== 'business'}
          />
        ) : null}
        {hasDrivers ? (
          <LegendItem
            label={editableKind === 'driver' ? 'Driver (tap to edit)' : 'Driver'}
            swatch={styles.keyDriver}
            muted={editableKind !== 'driver'}
          />
        ) : null}
        {hasCustomers ? (
          <LegendItem
            label={editableKind === 'customer' ? 'Customer (tap to edit)' : 'Customer'}
            swatch={styles.keyCustomer}
            muted={editableKind !== 'customer'}
          />
        ) : null}
        {hasAreas ? <LegendItem label="Service area" swatch={styles.keyArea} /> : null}
      </View>
    </View>
  );
}

function LegendItem({ label, swatch, muted }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.keyBase, swatch, muted && styles.keyMuted]} />
      <Text style={styles.legendLabel}>{label}</Text>
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
  keyBase: { width: 12, height: 12 },
  keyMuted: { opacity: MUTED_OPACITY },
  keyHome: { backgroundColor: colors.text, borderRadius: 2 },
  keyDriver: { backgroundColor: colors.accent, borderRadius: 6 },
  keyCustomer: { backgroundColor: colors.subtitle, borderRadius: 6, width: 10, height: 10 },
  keyArea: { borderWidth: 2, borderColor: colors.subtitle, borderRadius: 6, backgroundColor: 'transparent' },
  legendLabel: { fontSize: 12, color: colors.subtitle, fontWeight: '600' },
});
