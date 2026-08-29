import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import { Banner, Button, Card, Disclosure, Empty, Field, Pill, SectionTitle, ViewToggle } from '../components';
import EntityMapPanel from '../EntityMapPanel';
import LocationPicker from '../LocationPicker';
import { colors, radius, spacing } from '../theme';

export default function DriversScreen({ token, currentUserId, business }) {
  const [drivers, setDrivers] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [areas, setAreas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false);
  // The same drivers, two ways of looking at them — see ViewToggle.
  const [view, setView] = useState('list');

  // Scopes the "see everyone" map below to the business's own operating
  // area instead of an India-wide default — see MapPicker.web.js.
  const home =
    business && (business.home_lat || business.home_lng) ? { lat: business.home_lat, lng: business.home_lng } : null;

  const refresh = useCallback(async () => {
    try {
      const [driverResponse, customerResponse, areaResponse] = await Promise.all([
        api.listDrivers(token),
        api.listCustomers(token),
        api.listServiceAreas(token),
      ]);
      setDrivers(driverResponse.drivers || []);
      setCustomers(customerResponse.customers || []);
      setAreas(areaResponse.service_areas || []);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading) {
    return <ActivityIndicator style={styles.loader} color={colors.accent} />;
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Banner message={error} />
      <Banner message={notice} tone="success" />

      <Card>
        <SectionTitle
          right={
            <View style={styles.headingActions}>
              <ViewToggle
                value={view}
                onChange={setView}
                options={[
                  { value: 'list', label: 'List' },
                  { value: 'map', label: 'Map' },
                ]}
              />
              <HeadingAddButton
                open={adding}
                onPress={() => setAdding((prev) => !prev)}
                label={adding ? 'Cancel adding a driver' : 'Add a driver'}
              />
            </View>
          }
        >
          Drivers ({drivers.length})
        </SectionTitle>
        <View style={styles.headingDivider} />

        {adding ? (
          <NewDriverForm
            token={token}
            onCreated={async (name, pin) => {
              setNotice(`${name} can now sign in with their phone number and the PIN ${pin}.`);
              setAdding(false);
              await refresh();
            }}
            onError={setError}
          />
        ) : null}

        {view === 'map' ? (
          <EntityMapPanel
            token={token}
            editableKind="driver"
            home={home}
            drivers={drivers}
            customers={customers}
            areas={areas}
            onChanged={refresh}
            onError={setError}
          />
        ) : drivers.length === 0 ? (
          <Empty>No drivers yet. Add the first one with the + above.</Empty>
        ) : (
          drivers.map((driver, index) => (
            <DriverRow
              key={driver.id}
              driver={driver}
              token={token}
              business={business}
              isSelf={driver.id === currentUserId}
              isFirst={index === 0}
              onChanged={refresh}
              onError={setError}
              onNotice={setNotice}
            />
          ))
        )}
      </Card>
    </ScrollView>
  );
}

// The add form lives inside the roster card, revealed by the "+" on its
// heading — same shape as Service areas and Products on the Business tab.
// A separate "Add a driver" card above the list made adding look like a
// peer of the roster itself, when it is a rare action against it.
function NewDriverForm({ token, onCreated, onError }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.createDriver(token, { name, phone, pin });
      const created = { name, pin };
      setName('');
      setPhone('');
      setPin('');
      await onCreated(created.name, created.pin);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.inlineForm}>
      <Field label="Name" size="md" value={name} onChangeText={setName} placeholder="Ravi Kumar" />
      <Field
        label="Phone number"
        size="sm"
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        placeholder="98765 43210"
      />
      <Field
        label="PIN"
        value={pin}
        onChangeText={setPin}
        keyboardType="number-pad"
        maxLength={6}
        placeholder="6 digits"
        hint="Not all the same digit, and not a run like 123456. Tell the driver this PIN — you won't be able to read it back."
      />
      <Button
        title="Add driver"
        onPress={submit}
        busy={busy}
        disabled={!name.trim() || !phone.trim() || pin.length !== 6}
      />
      <Text style={styles.note}>
        Drivers sign in with their phone number and this PIN — no Google account and no email needed.
      </Text>
    </View>
  );
}

// The "+" that reveals the add form, on the card's own heading rather
// than in a card of its own. Same control as the Business tab's Service
// areas and Products headings.
function HeadingAddButton({ open, onPress, label }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={styles.addButton}>
      <Text style={styles.addButtonGlyph}>{open ? '×' : '+'}</Text>
    </Pressable>
  );
}

// One driver, as a row inside the shared Drivers card rather than a card
// of its own — see the "keep them together" note on DriversScreen above.
// A divider stands in for the border every separate Card used to draw,
// so three drivers still read as three distinct records without three
// boxes of whitespace between them.
function DriverRow({ driver, token, business, isSelf, isFirst, onChanged, onError, onNotice }) {
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [editingHome, setEditingHome] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [busy, setBusy] = useState(false);

  const act = async (action, after) => {
    setBusy(true);
    try {
      await action();
      if (after) {
        after();
      }
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const hasHome = !!(driver.home_lat || driver.home_lng);
  // One line of context under the name, rather than a standing disclosure
  // row per driver. Whether a finish point exists is worth seeing at a
  // glance; the map to change it is not.
  const meta = [driver.phone, hasHome ? 'finishes at a saved location' : 'no finish point yet']
    .filter(Boolean)
    .join(' · ');

  return (
    <View style={[styles.driverRow, !isFirst && styles.driverRowDivider]}>
      <View style={styles.driverHeader}>
        <View style={styles.driverHeaderText}>
          <Text style={styles.driverName}>{driver.name}</Text>
          <Text style={styles.driverMeta}>{meta}</Text>
        </View>
        <View style={styles.driverHeaderRight}>
          <Pill label={driver.active ? 'active' : 'deactivated'} tone={driver.active ? 'success' : 'neutral'} />
          <Pressable
            onPress={() => setOptionsOpen((prev) => !prev)}
            accessibilityRole="button"
            accessibilityLabel={`${optionsOpen ? 'Close options for' : 'Options for'} ${driver.name}`}
            style={[styles.optionsButton, optionsOpen && styles.optionsButtonOpen]}
          >
            <Text style={[styles.optionsDots, optionsOpen && styles.optionsDotsOpen]}>⋯</Text>
          </Pressable>
        </View>
      </View>

      {/* Everything that is not "who is this" lives here: where they
          finish, their PIN, whether they are active. All of it is rare
          next to how often this list is read, and showing any of it
          standing made every driver look like a settings panel — three
          drivers became a wall of identical horizontal rules with no way
          to tell which line separated two people and which sat inside
          one. Nested and tinted so it reads as belonging to the name
          above it rather than as the next entry down. */}
      {optionsOpen ? (
        <View style={styles.optionsPanel}>
          {resetting ? (
            <View>
              <Field
                label="New PIN"
                size="xs"
                value={newPin}
                onChangeText={setNewPin}
                keyboardType="number-pad"
                maxLength={6}
              />
              <View style={styles.buttonRow}>
                <Button
                  title="Set PIN"
                  busy={busy}
                  disabled={newPin.length !== 6}
                  onPress={() =>
                    act(
                      () => api.resetDriverPin(token, driver.id, newPin),
                      () => {
                        onNotice(`${driver.name}'s PIN is now ${newPin}.`);
                        setResetting(false);
                        setNewPin('');
                        setOptionsOpen(false);
                      }
                    )
                  }
                  style={styles.flexButton}
                />
                <Button
                  title="Cancel"
                  variant="secondary"
                  onPress={() => setResetting(false)}
                  style={styles.flexButton}
                />
              </View>
            </View>
          ) : (
            <View>
              <Disclosure compact open={editingHome} onToggle={() => setEditingHome((prev) => !prev)}>
                {hasHome ? 'Change where they finish' : 'Set where they finish'}
              </Disclosure>
              {editingHome ? (
                <View style={styles.homeEditor}>
                  <Text style={styles.note}>
                    A round ends when the driver gets home, not back at the depot — so this changes which stop
                    comes last on any route they&apos;re given. Saving it re-orders the route they&apos;re on
                    today.
                  </Text>
                  <LocationPicker
                    label={`Where ${driver.name} finishes`}
                    lat={driver.home_lat}
                    lng={driver.home_lng}
                    onChange={(lat, lng) =>
                      act(() => api.setDriverHome(token, driver.id, lat, lng), () =>
                        onNotice(`${driver.name}'s route will now finish at their home.`)
                      )
                    }
                    home={
                      business && (business.home_lat || business.home_lng)
                        ? { lat: business.home_lat, lng: business.home_lng }
                        : null
                    }
                    height={260}
                  />
                </View>
              ) : null}

              <View style={styles.buttonRow}>
                <Button
                  title="Reset PIN"
                  variant="secondary"
                  onPress={() => setResetting(true)}
                  style={styles.flexButton}
                />
                {!isSelf ? (
                  <Button
                    title={driver.active ? 'Deactivate' : 'Reactivate'}
                    variant={driver.active ? 'danger' : 'secondary'}
                    busy={busy}
                    onPress={() =>
                      act(() => api.setDriverActive(token, driver.id, !driver.active), () => setOptionsOpen(false))
                    }
                    style={styles.flexButton}
                  />
                ) : null}
              </View>

              {driver.active ? null : (
                <Text style={styles.note}>
                  Deactivated drivers are signed out immediately, including on a phone they still have in their
                  hand.
                </Text>
              )}
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, maxWidth: 720, width: '100%', alignSelf: 'center' },
  loader: { marginTop: spacing.xl * 2 },
  note: { fontSize: 12, color: colors.hint, marginTop: spacing.sm, lineHeight: 17 },
  headingDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginTop: -spacing.sm,
    marginBottom: spacing.md,
  },
  addButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButtonGlyph: { fontSize: 18, fontWeight: '700', color: colors.link, lineHeight: 20 },
  inlineForm: { marginBottom: spacing.md },
  headingActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  // A driver is one block: name, one line of context, and whatever they
  // opened. The only rule belongs *between* two drivers — an earlier
  // version also drew one inside each of them, above a standing "where
  // does this driver finish?" row, which made a roster of identical
  // horizontal lines where nothing grouped and no line meant anything in
  // particular.
  driverRow: { paddingVertical: spacing.md },
  driverRowDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  driverHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  driverHeaderText: { flex: 1 },
  driverHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  driverName: { fontSize: 16, fontWeight: '700', color: colors.text },
  driverMeta: { fontSize: 13, color: colors.subtitle, marginTop: 2 },
  optionsButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Filled while open, so it is obvious which driver the panel below
  // belongs to when several rows are on screen.
  optionsButtonOpen: { backgroundColor: colors.surfaceAlt },
  optionsDots: { fontSize: 20, fontWeight: '700', color: colors.subtitle, lineHeight: 20 },
  optionsDotsOpen: { color: colors.text },
  // Indented and tinted rather than separated by a rule: this is part of
  // the driver above it, not the next thing after them.
  optionsPanel: {
    marginTop: spacing.sm,
    marginLeft: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
  },
  homeEditor: { marginTop: spacing.sm },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, flexWrap: 'wrap' },
  flexButton: { flex: 1, minWidth: 130 },
});
