import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import * as api from './api';
import { Banner, Button, Card, Disclosure, Pill } from './components';
import { StopCard } from './routeCards';
import { lower } from './labels';
import { colors, radius, spacing } from './theme';

// One service area's route, as the person running the dairy thinks about
// it: a place, and who is driving it today.
//
// "Route" is the business's own word for this (labels.route — a school
// operator may call it a run), so it is never hardcoded in anything the
// admin reads.
//
// This replaces route management as the admin's daily surface. Routes are
// prepared automatically for every area that has work (see
// ensureDayRoutes), so "create a route" was never the job — the job is
// naming who goes out, and everything else follows from that. Picking two
// drivers splits the area between them, each finishing at their own home;
// picking one gives one route; picking nobody leaves it prepared and
// unassigned. There is no count to choose and no form to fill in.
//
// Everything that is not that one decision — re-optimizing, deleting,
// clearing the day — lives behind the options button, because it is rare,
// mostly destructive, and never what the morning is about.
export default function AreaRoutesCard({
  token,
  area,
  labels,
  routes,
  stops,
  drivers,
  products,
  date,
  onChanged,
  onError,
  onRebuild,
  rebuilding,
  onDelete,
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showOptions, setShowOptions] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const activeDrivers = drivers.filter((driver) => driver.active);
  const assigned = routes.map((route) => route.driver_id).filter(Boolean);
  const areaStops = stops.filter((stop) => routes.some((route) => route.id === stop.route_id));
  const totalMeters = routes.reduce((sum, route) => sum + (route.estimated_meters || 0), 0);

  // Toggling a driver re-plans the whole area, because that is what the
  // question "who is driving today" actually means — the split is derived
  // from the answer, never edited alongside it.
  const toggleDriver = async (driverId) => {
    const next = assigned.includes(driverId)
      ? assigned.filter((id) => id !== driverId)
      : [...assigned, driverId];
    setBusy(true);
    setError('');
    try {
      await api.setAreaDrivers(token, area.id, next, date);
      await onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.box}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.areaName}>{area.name}</Text>
          <Text style={styles.meta}>
            {areaStops.length} {areaStops.length === 1 ? 'delivery' : 'deliveries'}
            {totalMeters > 0 ? ` · about ${(totalMeters / 1000).toFixed(1)} km` : ''}
            {routes.length > 1 ? ` · split ${routes.length} ways` : ''}
          </Text>
        </View>
        <Pressable
          onPress={() => setShowOptions((prev) => !prev)}
          accessibilityRole="button"
          accessibilityLabel={`Options for ${area.name}`}
          style={styles.optionsButton}
        >
          <Text style={styles.optionsGlyph}>⋯</Text>
        </Pressable>
      </View>

      <Banner message={error} />

      <Text style={styles.label}>Who&apos;s driving?</Text>
      {activeDrivers.length === 0 ? (
        <Text style={styles.note}>No drivers yet — add one on the Drivers tab.</Text>
      ) : (
        <View style={styles.chipRow}>
          {activeDrivers.map((driver) => {
            const on = assigned.includes(driver.id);
            return (
              <Pressable
                key={driver.id}
                onPress={() => toggleDriver(driver.id)}
                disabled={busy}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                style={[styles.chip, on && styles.chipOn, busy && styles.chipBusy]}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]}>{driver.name}</Text>
              </Pressable>
            );
          })}
        </View>
      )}
      <Text style={styles.note}>
        {assigned.length === 0
          ? `Nobody assigned yet. Tap a name — the ${lower(labels.route)} is already planned and waiting.`
          : assigned.length === 1
            ? 'Finishes at their home. Tap another name to share the area between two drivers.'
            : `Split between ${assigned.length}, each taking the side nearest their own home.`}
      </Text>

      {routes.length > 1 ? (
        <View style={styles.splitList}>
          {routes.map((route) => {
            const driver = drivers.find((d) => d.id === route.driver_id);
            const count = stops.filter((stop) => stop.route_id === route.id).length;
            return (
              <View key={route.id} style={styles.splitRow}>
                <Text style={styles.splitName}>{driver ? driver.name : route.name}</Text>
                <Text style={styles.splitMeta}>
                  {count} stops · {((route.estimated_meters || 0) / 1000).toFixed(1)} km
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}

      {showOptions ? (
        <View style={styles.options}>
          <Text style={styles.optionsNote}>
            Rarely needed — the {lower(labels.route)} re-plans itself whenever you change who is driving.
          </Text>
          <View style={styles.optionsRow}>
            {onRebuild ? (
              <Button
                title={rebuilding ? 'Re-ordering…' : 'Re-order stops'}
                variant="secondary"
                onPress={onRebuild}
                disabled={rebuilding}
                style={styles.optionButton}
              />
            ) : null}
            {onDelete ? (
              <Button
                title={`Clear this ${lower(labels.route)}`}
                variant="danger"
                onPress={onDelete}
                style={styles.optionButton}
              />
            ) : null}
          </View>
        </View>
      ) : null}

      <Disclosure compact open={expanded} onToggle={() => setExpanded((prev) => !prev)}>
        {expanded ? 'Hide deliveries' : `Show deliveries (${areaStops.length})`}
      </Disclosure>
      {expanded ? (
        <View style={styles.stopList}>
          {areaStops.map((stop) => (
            <StopCard
              key={stop.id}
              stop={stop}
              products={products}
              token={token}
              onChanged={onChanged}
              onError={onError}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

// A route the automatic per-area preparation cannot explain: one an admin
// built by hand, or one left over from a service area since removed.
// Shown plainly rather than hidden, with the same driver picker it always
// had, so nothing an admin made ever disappears from the screen.
export function LooseRouteCard({ route, stops, drivers, products, token, onChanged, onError, onDelete, labels }) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const routeStops = stops.filter((stop) => stop.route_id === route.id);

  const assign = async (driverId) => {
    setBusy(true);
    try {
      await api.assignRoute(token, route.id, driverId);
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.box}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.areaName}>{route.name}</Text>
          <Text style={styles.meta}>
            {routeStops.length} stops · about {((route.estimated_meters || 0) / 1000).toFixed(1)} km
          </Text>
        </View>
        <Pill label="one-off" tone="neutral" />
      </View>

      <Text style={styles.label}>Who&apos;s driving?</Text>
      <select
        value={route.driver_id || ''}
        disabled={busy}
        onChange={(event) => assign(event.target.value)}
        style={looseSelectStyle}
      >
        <option value="">No driver assigned</option>
        {drivers
          .filter((driver) => driver.active)
          .map((driver) => (
            <option key={driver.id} value={driver.id}>
              {driver.name}
            </option>
          ))}
      </select>

      {onDelete ? (
        <Button title={`Clear this ${lower(labels.route)}`} variant="secondary" onPress={onDelete} style={styles.spaced} />
      ) : null}

      <Disclosure compact open={expanded} onToggle={() => setExpanded((prev) => !prev)}>
        {expanded ? 'Hide deliveries' : `Show deliveries (${routeStops.length})`}
      </Disclosure>
      {expanded ? (
        <View style={styles.stopList}>
          {routeStops.map((stop) => (
            <StopCard
              key={stop.id}
              stop={stop}
              products={products}
              token={token}
              onChanged={onChanged}
              onError={onError}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const looseSelectStyle = {
  width: 'auto',
  minWidth: 160,
  maxWidth: 260,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: radius.md,
  paddingTop: spacing.sm,
  paddingBottom: spacing.sm,
  paddingLeft: spacing.md,
  paddingRight: spacing.md,
  fontSize: 15,
  color: colors.text,
  backgroundColor: colors.surface,
  fontFamily: 'inherit',
  marginBottom: spacing.sm,
};

const styles = StyleSheet.create({
  box: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: spacing.sm },
  headerText: { flex: 1 },
  areaName: { fontSize: 16, fontWeight: '700', color: colors.text },
  meta: { fontSize: 13, color: colors.subtitle, marginTop: 2 },
  optionsButton: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  optionsGlyph: { fontSize: 18, color: colors.label, fontWeight: '700', lineHeight: 20 },
  label: { fontSize: 13, fontWeight: '600', color: colors.label, marginTop: spacing.md, marginBottom: spacing.xs },
  note: { fontSize: 12, color: colors.hint, marginTop: spacing.xs, lineHeight: 17 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    minHeight: 40,
    justifyContent: 'center',
  },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipBusy: { opacity: 0.6 },
  chipText: { fontSize: 14, color: colors.label, fontWeight: '600' },
  chipTextOn: { color: colors.accentText },
  splitList: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.sm },
  splitRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: spacing.xs, gap: spacing.sm },
  splitName: { fontSize: 14, fontWeight: '600', color: colors.text },
  splitMeta: { fontSize: 13, color: colors.subtitle },
  options: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
  optionsNote: { fontSize: 12, color: colors.hint, marginBottom: spacing.sm, lineHeight: 17 },
  optionsRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  optionButton: { flex: 1, minWidth: 150 },
  spaced: { marginTop: spacing.sm },
  stopList: { marginTop: spacing.sm },
});
