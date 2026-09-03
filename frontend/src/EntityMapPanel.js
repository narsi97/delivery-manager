import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import * as api from './api';
import { Button } from './components';
import { ReadOnlyEntityCard } from './EntityCard';
import EntityMap from './EntityMap';
import { splitOutliers } from './mapFit';
import { InlineLocationEditor } from './LocationPicker';
import { colors, radius, spacing } from './theme';

// "See everyone on a map, edit your own kind" — the map half of a roster
// screen, shown when its List/Map toggle is on Map.
//
// It used to be a card of its own below the list, which made the same
// hundred customers look like two separate things stacked on the page.
// They are one thing seen two ways, so it lives inside the roster card
// now and this component is the panel rather than the card.
//
// Shared between Customers and Drivers so the two can't quietly drift
// apart the way api.planRoutes and its call site once did (see
// DayRouteMapPanel's own comment for the same reasoning). editableKind
// picks which pins are interactive; the rest render muted with a
// read-only card on tap (see EntityMap.js / EntityCard.js). The Business
// tab's own map does the equivalent inline, since it's the one place both
// customers and drivers are editable together.
export default function EntityMapPanel({
  token,
  editableKind,
  home,
  drivers = [],
  customers = [],
  areas = [],
  onChanged,
  onError,
}) {
  // How many pins the opening view deliberately leaves off — the same
  // split the map itself uses, so the count and the view can't disagree.
  // Same list, in the same shape, that EntityMap fits the view to —
  // drivers keep their location in home_lat/home_lng, not lat/lng.
  const offMap = splitOutliers(
    [
      ...(customers || []).map((c) => ({ lat: c.lat, lng: c.lng })),
      ...(drivers || []).map((d) => ({ lat: d.home_lat, lng: d.home_lng })),
      ...(home ? [{ lat: home.lat, lng: home.lng }] : []),
    ].filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && (p.lat !== 0 || p.lng !== 0)),
  ).outliers.length;
  const [selected, setSelected] = useState(null); // { kind, data }

  const save = async (lat, lng) => {
    try {
      if (selected.kind === 'customer') {
        await api.updateCustomer(token, selected.data.id, { lat, lng });
      } else {
        await api.setDriverHome(token, selected.data.id, lat, lng);
      }
      await onChanged();
      setSelected(null);
    } catch (err) {
      onError(err.message);
    }
  };

  const kindWord = editableKind === 'driver' ? 'driver' : 'customer';

  return (
    <View>
      <Text style={styles.note}>
        Every {kindWord} you have, plus {kindWord === 'driver' ? 'customers' : 'drivers'} and your business shown muted
        for reference. Tap a {kindWord} to move their pin; tap anything else to see what it is.
      </Text>

      <EntityMap
        home={home}
        drivers={drivers}
        customers={customers}
        areas={areas}
        editableKind={editableKind}
        selectedId={selected?.kind === editableKind ? selected.data.id : null}
        onSelect={setSelected}
      />

      {selected && selected.kind === editableKind ? (
        <View style={styles.selectedBox}>
          <Text style={styles.selectedName}>
            {selected.kind === 'driver' ? `${selected.data.name} finishes at` : selected.data.name}
          </Text>
          <Text style={styles.selectedMeta}>
            {selected.kind === 'customer'
              ? [selected.data.address, selected.data.phone].filter(Boolean).join(' · ') || 'No contact details yet'
              : selected.data.phone || 'No phone on file'}
          </Text>
          <InlineLocationEditor
            lat={selected.kind === 'customer' ? selected.data.lat : selected.data.home_lat}
            lng={selected.kind === 'customer' ? selected.data.lng : selected.data.home_lng}
            onSave={save}
            home={home}
            drivers={drivers}
            customers={customers}
          />
          <Button title="Done" variant="secondary" onPress={() => setSelected(null)} style={styles.spaced} />
        </View>
      ) : selected ? (
        <View>
          <ReadOnlyEntityCard kind={selected.kind} data={selected.data} />
          <Button title="Done" variant="secondary" onPress={() => setSelected(null)} style={styles.spaced} />
        </View>
      ) : (
        <View>
          <Text style={styles.note}>Tap any pin to see who it is and act on it.</Text>
          {/* The view frames the bulk of the work, so a genuine outlier
              can sit off-screen. Saying so beats a map that quietly
              leaves somebody out — see splitOutliers in mapFit.js. */}
          {offMap > 0 ? (
            <Text style={styles.note}>
              {offMap} {offMap === 1 ? 'pin sits' : 'pins sit'} far outside the rest — zoom out to see
              {offMap === 1 ? ' it' : ' them'}.
            </Text>
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  note: { fontSize: 12, color: colors.hint, marginTop: spacing.sm, marginBottom: spacing.sm, lineHeight: 17 },
  spaced: { marginTop: spacing.sm },
  selectedBox: {
    marginTop: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
  },
  selectedName: { fontSize: 16, fontWeight: '700', color: colors.text },
  selectedMeta: { fontSize: 13, color: colors.subtitle, marginTop: 2, marginBottom: spacing.sm },
});
