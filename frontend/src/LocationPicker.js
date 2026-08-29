import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Banner, Button, Field } from './components';
import MapPicker from './MapPicker';
import { mapLinkError, parseMapLink } from './mapLinks';
import { currentPosition } from './navigation';
import { colors, radius, spacing } from './theme';

// How a location gets set, everywhere in this app.
//
// It used to be two text fields called Latitude and Longitude. Nobody
// types coordinates — they are fifteen characters of decimal that mean
// nothing to read back, can't be checked by eye, and are wrong in a way
// you only discover when a driver is standing in the wrong street. They
// were in this app because they were the easiest thing to build, not
// because anyone wanted them.
//
// Three ways in, in the order people actually have the information:
//
//   - Drop the pin. Always available, needs nothing, and is the only one
//     that works while standing in a field pointing at a gate.
//   - Use my current location. The right answer when the admin is at the
//     door, which is exactly when a customer gets added.
//   - Paste a map link. How a location arrives in practice — someone
//     sends a Google Maps link on WhatsApp. See mapLinks.js.
//
// The coordinates are still there underneath; they are just never the
// interface. What's shown instead is whether a pin exists at all, since
// that is the only part a human can act on.
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

  const hasPin = Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0);

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

      <MapPicker
        lat={lat}
        lng={lng}
        onChange={(newLat, newLng) => {
          setError('');
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

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.md },
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
