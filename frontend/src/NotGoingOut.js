import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import * as api from './api';
import { Banner, Button, Card, Disclosure, Field } from './components';
import LocationPicker from './LocationPicker';
import { groupStopsByCustomer, StopCard } from './routeCards';
import { lower } from './labels';
import { nearestAreaFor } from './serviceAreas';
import { colors, spacing } from './theme';

// Everything that isn't going out today, and why.
//
// The grouping outlived the card it was built for. It was two cards
// once — "Not yet on a route" and "Outside your service routes" — which
// on a business that had drawn no areas were the same deliveries listed
// twice under two headings, one the symptom and one the cause. That
// became a single card grouped by cause, at the foot of the day.
//
// The card is gone now too. The day board already carried a warning per
// problem at the top, so the card was the third telling: a banner named
// it, then you scrolled past the whole round to find it again. What is
// left here is the part that was always the useful bit — which cause a
// delivery belongs to, and what fixes it — for the banners to open onto.
// See TodayScreen and Docs/DESIGN.md.
//
// A delivery is only ever in one group, and the counts add up to the
// deliveries that are not going out.
// Why a delivery is not going out, in the order the reasons have to be
// fixed. No pin comes first because nothing else can be decided without
// one.
//
// Split out so the day board can state each reason once, in its own
// warning, and open it there. It used to be a card at the foot of the
// page: the banner named the problem, and then you scrolled past the
// whole round to find it again under a different heading. Saying it in
// two places is saying it twice. See Docs/DESIGN.md.
export function notGoingOutCauses(stops, areas) {
  const pending = stops.filter((stop) => !stop.route_id && stop.status === 'pending');
  const unpinned = [];
  const outside = [];
  const waiting = [];
  for (const stop of pending) {
    if (!stop.lat && !stop.lng) {
      unpinned.push(stop);
    } else if (!nearestAreaFor(stop.lat, stop.lng, areas)) {
      outside.push(stop);
    } else {
      waiting.push(stop);
    }
  }
  return { pending, unpinned, outside, waiting };
}

// The deliveries behind one reason, with no heading of their own — the
// warning that opened them is the heading.
export function CauseStops({ stops, products, token, home, areas, onChanged, onError, children }) {
  if (stops.length === 0) {
    return null;
  }
  return (
    <View>
      {children}
      {groupStopsByCustomer(stops).map((door) => (
        <StopCard
          key={door[0].customer_id || door[0].id}
          stops={door}
          products={products}
          token={token}
          onChanged={onChanged}
          onError={onError}
          home={home}
          focusAreas={areas || []}
        />
      ))}
    </View>
  );
}

export function OneOffRoute({ token, stops, areas, home, date, labels, onDone }) {
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
      setError(`Set where this ${lower(labels.route)} starts from first — use your location, or drop a pin on the map.`);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const area = nearestAreaFor(lat, lng, areas);
      const result = await api.buildRoute(token, {
        start_lat: lat,
        start_lng: lng,
        name: name.trim() || (area ? `${area.name} ${lower(labels.route)}` : `Extra ${lower(labels.route)}`),
        order_ids: stops.map((stop) => stop.id),
        date: date || undefined,
      });
      await onDone(`${labels.route} built with ${result.stops.length} stops.`);
      setExpanded(false);
      setName('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.oneOff}>
      <Disclosure compact open={expanded} onToggle={() => setExpanded((prev) => !prev)}>
        Build a one-off {lower(labels.route)} for these {stops.length}
      </Disclosure>
      {expanded ? (
        <View>
          <Banner message={error} />
          <Field label="Name (optional)" size="md" value={name} onChangeText={setName} placeholder={`Extra ${lower(labels.route)}`} />
          <LocationPicker
            label={`Where does this ${lower(labels.route)} start?`}
            lat={Number(depot.lat) || 0}
            lng={Number(depot.lng) || 0}
            onChange={(lat, lng) => setDepot({ lat: lat.toFixed(6), lng: lng.toFixed(6) })}
            home={home}
            areas={areas}
          />
          <Button title={`Build a ${lower(labels.route)} for these ${stops.length}`} onPress={build} busy={busy} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  headingDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginTop: -spacing.sm,
    marginBottom: spacing.sm,
  },
  group: { marginBottom: spacing.xs },
  explanation: { fontSize: 13, color: colors.subtitle, marginBottom: spacing.sm, lineHeight: 18 },
  oneOff: { marginBottom: spacing.sm },
});
