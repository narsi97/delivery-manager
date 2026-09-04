import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import * as api from './api';
import { Banner, Button, Card, Disclosure, Field, Pill, SectionTitle } from './components';
import LocationPicker from './LocationPicker';
import { groupStopsByCustomer, StopCard } from './routeCards';
import { lower } from './labels';
import { nearestAreaFor } from './serviceAreas';
import { colors, spacing } from './theme';

// Everything that isn't going out today, and why.
//
// This used to be two cards. "Not yet on a route" listed every unrouted
// delivery; "Outside your service routes" listed the ones with a pin that
// no area covered. On a business that hasn't drawn its areas yet those
// are the *same deliveries*, so the screen showed the identical count
// twice under two different headings and left the reader to work out
// whether they were one problem or two. They were one problem described
// at two levels: the symptom, and its cause.
//
// So: one card, grouped by cause, with the fix attached to each group.
// A delivery is only ever in one group, the counts add up to the total,
// and the heading says the thing the admin actually cares about — these
// are not going out — rather than naming an internal state.
export default function NotGoingOut({ token, stops, areas, home, date, products, labels, onChanged, onError, onNotice }) {
  const pending = stops.filter((stop) => !stop.route_id && stop.status === 'pending');
  if (pending.length === 0) {
    return null;
  }

  // Three reasons, checked in the order they have to be fixed. No pin
  // comes first because nothing else can be decided without one.
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

  return (
    <Card>
      <SectionTitle right={<Pill label={String(pending.length)} tone="warning" />}>Not going out yet</SectionTitle>
      <View style={styles.headingDivider} />

      <CauseGroup
        title="We don't know where they live"
        count={unpinned.length}
        explanation={`Without a pin on the map there is no way to put ${
          unpinned.length === 1 ? 'this delivery' : 'these deliveries'
        } in order, so they are left out. Open the customer and drop a pin where you deliver — the written address isn't enough on its own.`}
        stops={unpinned}
        products={products}
        token={token}
        onChanged={onChanged}
        onError={onError}
      />

      <CauseGroup
        title="Outside where you deliver"
        count={outside.length}
        explanation={`These sit outside every service ${lower(labels.route)} you've set up, so no ${lower(labels.route)} covers them. Setting one up on the Business tab fixes it for good — every day from then on. To get just today out, build a one-off ${lower(labels.route)} for them below.`}
        stops={outside}
        products={products}
        token={token}
        onChanged={onChanged}
        onError={onError}
      >
        <OneOffRoute token={token} stops={outside} areas={areas} home={home} date={date} labels={labels} onDone={onNotice} />
      </CauseGroup>

      <CauseGroup
        title={`Waiting for a ${lower(labels.route)}`}
        count={waiting.length}
        explanation={`These are inside an area you deliver to, so a ${lower(labels.route)} will pick them up. If they're still here after a reload, the area's ${lower(labels.route)} was cleared — it comes back on its own tomorrow, or you can rebuild it from its options.`}
        stops={waiting}
        products={products}
        token={token}
        onChanged={onChanged}
        onError={onError}
      />
    </Card>
  );
}

// One reason, its explanation, its deliveries, and whatever action is
// specific to it. Hidden entirely when nothing has this problem, so a
// business only ever reads the causes it actually has.
function CauseGroup({ title, count, explanation, stops, products, token, onChanged, onError, children }) {
  const [expanded, setExpanded] = useState(false);
  if (count === 0) {
    return null;
  }

  return (
    <View style={styles.group}>
      <Disclosure
        open={expanded}
        onToggle={() => setExpanded((prev) => !prev)}
        right={<Pill label={String(count)} tone="neutral" />}
      >
        {title}
      </Disclosure>
      {expanded ? (
        <View>
          <Text style={styles.explanation}>{explanation}</Text>
          {children}
          {groupStopsByCustomer(stops).map((door) => (
            <StopCard
              key={door[0].customer_id || door[0].id}
              stops={door}
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

// Today's way out for deliveries no area covers: put them on a route of
// their own. Deliberately not automatic — dropping a customer 60km away
// onto whichever route happened to exist is exactly the behaviour that
// made service areas necessary in the first place.
//
// Owns its own error state rather than pushing it to a banner at the top
// of the page: an error about this action belongs next to this action,
// where the person who pressed the button is already looking.
function OneOffRoute({ token, stops, areas, home, date, labels, onDone }) {
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
