import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Banner, Button, Field } from './components';
import MapPicker from './MapPicker';
import { mapLinkError, parseMapLink } from './mapLinks';
import { currentPosition } from './navigation';
import { colors, radius, spacing } from './theme';

// How a location gets set, everywhere in this app.
//
// This was once nothing but two text fields called Latitude and
// Longitude, which is the app asking a human to be a geocoder. Nobody
// *composes* a location out of decimals; you know where the gate is, and
// fifteen characters of decimal are wrong in a way you only discover
// when a driver is standing in the wrong street.
//
// Four ways in, in the order people actually have the information:
//
//   - Drop the pin. Always available, needs nothing, and is the only one
//     that works while standing in a field pointing at a gate.
//   - Use my current location. The right answer when the admin is at the
//     door, which is exactly when a customer gets added.
//   - Paste a map link. How a location arrives in practice — someone
//     sends a Google Maps link on WhatsApp. See mapLinks.js.
//   - Type the coordinates. Last, and deliberately so — but a business
//     that has been running a while already holds a list of them, from a
//     previous system or a spreadsheet or a driver's phone, and telling
//     them to re-drop ninety pins they already have is the app being
//     precious. They also read back what the pin says, which makes them
//     the only way to check a pin against a number someone sent you.
//
// Everything that sets the pin sits above the map, in that order, and
// the map is the last thing — the big confirmation that whatever you
// just did landed in the right street.
export default function LocationPicker({
  lat,
  lng,
  onChange,
  home = null,
  areas = [],
  drivers = [],
  customers = [],
  previewRadiusMeters = null,
  height = 300,
  label = 'Location',
  hint,
  onSelectReference,
}) {
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const [pasting, setPasting] = useState(false);
  // What is in the coordinate boxes while they are being typed in.
  // Null means "show whatever the pin says" — which is every moment
  // except the one where somebody is halfway through typing "17.0" and
  // would not thank us for snapping the map to the equator.
  const [typed, setTyped] = useState(null);

  const hasPin = Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0);
  const shown = typed || {
    lat: hasPin ? String(lat) : '',
    lng: hasPin ? String(lng) : '',
  };

  // Committed on blur, not per keystroke: a coordinate is only a
  // location once it is finished, and moving the pin to each prefix of
  // what someone is typing is a map that jumps around under them.
  const commitTyped = () => {
    if (!typed) {
      return;
    }
    const nextLat = Number(typed.lat);
    const nextLng = Number(typed.lng);
    setTyped(null);
    if (typed.lat.trim() === '' && typed.lng.trim() === '') {
      return;
    }
    if (!Number.isFinite(nextLat) || !Number.isFinite(nextLng)) {
      setError('Those coordinates are not numbers. A pin looks like 17.057500, 79.268400.');
      return;
    }
    if (nextLat < -90 || nextLat > 90 || nextLng < -180 || nextLng > 180) {
      setError('Latitude runs from -90 to 90 and longitude from -180 to 180 — those are the wrong way round, maybe?');
      return;
    }
    setError('');
    onChange(nextLat, nextLng);
  };

  const useMyLocation = async () => {
    setError('');
    const position = await currentPosition();
    if (!position) {
      setError('Could not read your location. Drop the pin on the map instead, or paste a map link.');
      return;
    }
    onChange(position.lat, position.lng);
  };

  const applyLink = () => {
    const parsed = parseMapLink(link);
    if (!parsed) {
      setError(mapLinkError(link));
      return;
    }
    setError('');
    setLink('');
    setPasting(false);
    onChange(parsed.lat, parsed.lng);
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <Text style={styles.label}>{label}</Text>
        <Text style={[styles.status, hasPin ? styles.statusSet : styles.statusUnset]}>
          {hasPin ? '✓ Pinned' : 'Not set yet'}
        </Text>
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}

      <Banner message={error} />

      <View style={styles.buttonRow}>
        <Button title="Use my current location" variant="secondary" onPress={useMyLocation} style={styles.flexButton} />
        <Button
          title={pasting ? 'Cancel' : 'Paste a map link'}
          variant="secondary"
          onPress={() => {
            setPasting((prev) => !prev);
            setError('');
          }}
          style={styles.flexButton}
        />
      </View>

      {pasting ? (
        <View style={styles.pasteBox}>
          <Field
            label="Map link"
            value={link}
            onChangeText={setLink}
            placeholder="https://maps.google.com/..."
            autoCapitalize="none"
          />
          <Button title="Use this link" onPress={applyLink} disabled={!link.trim()} />
          <Text style={styles.hint}>
            Paste a link shared from Google Maps, Apple Maps or OpenStreetMap. Short links (maps.app.goo.gl) need
            opening once in Maps first, then copy the full address bar link.
          </Text>
        </View>
      ) : null}

      {/* Raw inputs rather than Field: two numbers on one line with a
          label each, sized to the number that goes in them. Field's
          block layout would give each of them a paragraph. */}
      <View style={styles.coordRow}>
        <View>
          <Text style={styles.coordLabel}>Latitude</Text>
          <input
            value={shown.lat}
            inputMode="decimal"
            placeholder="17.057500"
            aria-label="Latitude"
            onChange={(event) => setTyped({ ...shown, lat: event.target.value })}
            onBlur={commitTyped}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitTyped();
              }
            }}
            style={coordInputStyle}
          />
        </View>
        <View>
          <Text style={styles.coordLabel}>Longitude</Text>
          <input
            value={shown.lng}
            inputMode="decimal"
            placeholder="79.268400"
            aria-label="Longitude"
            onChange={(event) => setTyped({ ...shown, lng: event.target.value })}
            onBlur={commitTyped}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitTyped();
              }
            }}
            style={coordInputStyle}
          />
        </View>
      </View>

      <MapPicker
        lat={lat}
        lng={lng}
        onChange={(newLat, newLng) => {
          setError('');
          setTyped(null);
          onChange(newLat, newLng);
        }}
        home={home}
        areas={areas}
        drivers={drivers}
        customers={customers}
        previewRadiusMeters={previewRadiusMeters}
        height={height}
        onSelectReference={onSelectReference}
      />

      <Text style={styles.hint}>
        Tap or drag on the map to place the pin. The pin — not the written address — is what orders the route.
      </Text>
    </View>
  );
}

// A location editor sized for the spot inside a "you tapped a pin" panel
// — Routes/Today's selected stop, or a customer/driver glimpsed from
// someone else's map — rather than a full form. Buffers the pin locally
// and only calls onSave when the admin presses Save, the same
// buffer-then-submit shape every other form-inside-a-card in this app
// already uses; LocationPicker itself fires onChange per click/drag,
// which is right for a form field but wrong here, where committing a
// customer's door to a new spot deserves a deliberate action.
export function InlineLocationEditor({ lat, lng, onSave, home, areas, drivers, customers, height = 240 }) {
  const [draft, setDraft] = useState({ lat, lng });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty = draft.lat !== lat || draft.lng !== lng;

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await onSave(draft.lat, draft.lng);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <Banner message={error} />
      <LocationPicker
        label="Location"
        lat={draft.lat}
        lng={draft.lng}
        onChange={(newLat, newLng) => setDraft({ lat: newLat, lng: newLng })}
        home={home}
        areas={areas}
        drivers={drivers}
        customers={customers}
        height={height}
      />
      <Button title="Save location" onPress={save} busy={busy} disabled={!dirty} />
    </View>
  );
}

const coordInputStyle = {
  width: 130,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: radius.md,
  paddingTop: 7,
  paddingBottom: 7,
  paddingLeft: spacing.sm,
  paddingRight: spacing.sm,
  fontSize: 14,
  color: colors.text,
  backgroundColor: colors.surface,
  fontFamily: 'inherit',
};

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.md },
  coordRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, marginBottom: spacing.sm },
  coordLabel: { fontSize: 12, fontWeight: '600', color: colors.label, marginBottom: 3 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.xs },
  label: { fontSize: 13, fontWeight: '600', color: colors.label },
  status: { fontSize: 13, fontWeight: '700' },
  statusSet: { color: colors.success },
  statusUnset: { color: colors.hint },
  hint: { fontSize: 12, color: colors.hint, marginTop: spacing.xs, lineHeight: 17 },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  flexButton: { flex: 1, minWidth: 150 },
  pasteBox: {
    marginTop: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
  },
});
