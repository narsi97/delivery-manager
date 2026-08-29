import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import * as api from './api';
import { Banner, Button, Card, Disclosure, Pill } from './components';
import { ReadOnlyEntityCard } from './EntityCard';
import { InlineLocationEditor } from './LocationPicker';
import { selectStyle } from './routeCards';
import RouteMap from './RouteMap';
import { colors, radius, spacing } from './theme';

// The day's drop points, coloured by route, with a tap-to-act control —
// shared between the Routes tab (where it's the map for planning) and
// the Today tab (a second lens on the same day, alongside the list).
// Built once so the two can never quietly drift apart, the way
// api.planRoutes and its call site once did.
//
// Selection lives here rather than inside the map: the map's job is
// geography, and "which route should this go on" or "where is this
// customer's door" is a picker/editor like every other control in this
// app. Keeping them apart means the map never has to grow a popup form.
export default function DayRouteMapCard({ token, stops, routes, drivers, home, onChanged }) {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState(null); // { kind: 'stop'|'driver'|'business', id? }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Stop selection is re-read from the freshly loaded list on every
  // render, so after a move or a location edit it shows the new state
  // rather than the stale copy captured when it was tapped.
  const selectedStop =
    selected?.kind === 'stop' ? stops.find((stop) => stop.id === selected.id) || null : null;
  const currentRoute = selectedStop ? routes.find((route) => route.id === selectedStop.route_id) : null;

  const move = async (routeId) => {
    setBusy(true);
    setError('');
    try {
      await api.moveStopToRoute(token, selectedStop.id, routeId);
      await onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const saveStopLocation = async (lat, lng) => {
    await api.updateCustomer(token, selectedStop.customer_id, { lat, lng });
    await onChanged();
  };

  const unroutedCount = stops.filter((stop) => !stop.route_id).length;

  return (
    <Card>
      <Disclosure
        open={expanded}
        onToggle={() => setExpanded((prev) => !prev)}
        right={unroutedCount > 0 ? <Pill label={`${unroutedCount} unassigned`} tone="warning" /> : null}
      >
        Check the route map
      </Disclosure>

      {expanded ? (
        <View>
          <Banner message={error} />
          <Text style={styles.note}>
            Every drop point for this day, coloured by the route it&apos;s on. Drivers and your business are shown
            muted for reference. Tap a stop to move it or fix its pin; tap anything else to see what it is.
          </Text>

          <RouteMap
            stops={stops}
            routes={routes}
            home={home}
            drivers={drivers}
            selectedStopId={selectedStop?.id || null}
            onSelect={(stop) => setSelected({ kind: 'stop', id: stop.id })}
            onSelectOther={(entity) => setSelected({ kind: entity.kind, data: entity.data })}
          />

          {selectedStop ? (
            <View style={styles.selectedBox}>
              <Text style={styles.selectedName}>{selectedStop.customer_name}</Text>
              <Text style={styles.selectedMeta}>
                {selectedStop.quantity} × {selectedStop.product_name}
                {selectedStop.customer_address ? ` · ${selectedStop.customer_address}` : ''}
              </Text>
              <Text style={styles.selectedMeta}>Currently on: {currentRoute ? currentRoute.name : 'no route'}</Text>

              <Text style={styles.moveLabel}>Move to</Text>
              <select
                value={selectedStop.route_id || ''}
                disabled={busy}
                onChange={(event) => move(event.target.value)}
                style={moveSelectStyle}
              >
                <option value="">Take off every route</option>
                {routes.map((route) => (
                  <option key={route.id} value={route.id}>
                    {route.name}
                  </option>
                ))}
              </select>

              <View style={styles.locationSection}>
                <Text style={styles.moveLabel}>Wrong door?</Text>
                <InlineLocationEditor
                  lat={selectedStop.lat}
                  lng={selectedStop.lng}
                  onSave={saveStopLocation}
                  home={home}
                  drivers={drivers}
                  height={220}
                />
              </View>

              <Button title="Done" variant="secondary" onPress={() => setSelected(null)} style={styles.spaced} />
            </View>
          ) : selected ? (
            <View>
              <ReadOnlyEntityCard kind={selected.kind} data={selected.data} />
              <Button title="Done" variant="secondary" onPress={() => setSelected(null)} style={styles.spaced} />
            </View>
          ) : (
            <Text style={styles.note}>Tap any pin to see who it is and act on it.</Text>
          )}
        </View>
      ) : null}
    </Card>
  );
}

// Sized to content like every other picker in this app — a route name is
// a few words, not a paragraph. See routeCards.js's compactSelectStyle.
const moveSelectStyle = { ...selectStyle, width: 'auto', minWidth: 180, maxWidth: 300, flexGrow: 0 };

const styles = StyleSheet.create({
  note: { fontSize: 12, color: colors.hint, marginTop: spacing.sm, lineHeight: 17 },
  spaced: { marginTop: spacing.sm },
  selectedBox: {
    marginTop: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
  },
  selectedName: { fontSize: 16, fontWeight: '700', color: colors.text },
  selectedMeta: { fontSize: 13, color: colors.subtitle, marginTop: 2 },
  moveLabel: { fontSize: 13, fontWeight: '600', color: colors.label, marginTop: spacing.md, marginBottom: spacing.xs },
  locationSection: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.xs },
});
