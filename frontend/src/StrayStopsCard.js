import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import * as api from './api';
import { Banner, Button, Card, Disclosure, Field, SectionTitle } from './components';
import LocationPicker from './LocationPicker';
import { nearestAreaFor } from './serviceAreas';
import { colors, spacing } from './theme';

// The one case that still needs a human: deliveries whose customer sits
// outside every service area. They are deliberately never auto-absorbed —
// putting a customer 60km away on whichever route happened to exist is
// exactly the bug that made this rewrite necessary — so they surface here
// with the two real ways out: draw a service area around them (the fix
// that also handles tomorrow), or put them on a one-off route today.
//
// Owns its own error state rather than pushing it to a banner at the top
// of the page: an error about this action belongs next to this action,
// where the person who pressed the button is already looking.
export default function StrayStopsCard({ token, stops, areas, home, date, onDone }) {
  const [expanded, setExpanded] = useState(false);
  const [depot, setDepot] = useState(() =>
    home ? { lat: String(home.lat), lng: String(home.lng) } : { lat: '', lng: '' }
  );
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const build = async () => {
    const lat = Number(depot.lat);
    const lng = Number(depot.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
      setError('Set where this route starts from first — use your location, drop a pin, or type the coordinates.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const area = nearestAreaFor(lat, lng, areas);
      const result = await api.buildRoute(token, {
        start_lat: lat,
        start_lng: lng,
        name: name.trim() || (area ? `${area.name} route` : 'Extra route'),
        order_ids: stops.map((stop) => stop.id),
        date: date || undefined,
      });
      await onDone(`Route built with ${result.stops.length} stops.`);
      setExpanded(false);
      setName('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <SectionTitle>Outside your service areas ({stops.length})</SectionTitle>
      <Text style={styles.note}>
        These deliveries have a pin but sit outside every service area, so no route covers them. The lasting fix is
        to add a service area around them on the Business tab — then they get their own route every day. To handle
        just today, build a one-off route for them here.
      </Text>

      {stops.slice(0, 5).map((stop) => (
        <Text key={stop.id} style={styles.strayLine}>
          {stop.customer_name}
          {stop.customer_address ? ` · ${stop.customer_address}` : ''}
        </Text>
      ))}
      {stops.length > 5 ? <Text style={styles.strayLine}>…and {stops.length - 5} more</Text> : null}

      <Disclosure open={expanded} onToggle={() => setExpanded((prev) => !prev)}>
        Build a one-off route for these
      </Disclosure>

      {expanded ? (
        <View>
          <Banner message={error} />
          <Field label="Route name" size="md" value={name} onChangeText={setName} placeholder="Extra route" />
          <LocationPicker
            label="Where does this route start?"
            lat={Number(depot.lat) || 0}
            lng={Number(depot.lng) || 0}
            onChange={(lat, lng) => setDepot({ lat: lat.toFixed(6), lng: lng.toFixed(6) })}
            home={home}
            areas={areas}
          />
          <Button title={`Build a route for these ${stops.length}`} onPress={build} busy={busy} style={styles.spaced} />
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  note: { fontSize: 12, color: colors.hint, marginTop: spacing.sm, lineHeight: 17 },
  spaced: { marginTop: spacing.sm },
  strayLine: { fontSize: 13, color: colors.label, marginTop: spacing.xs },
});
