import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import { Banner, Button, Card, Disclosure, Empty, Field, Pill, SectionTitle } from '../components';
import EntityMapCard from '../EntityMapCard';
import LocationPicker from '../LocationPicker';
import { colors, spacing } from '../theme';

export default function DriversScreen({ token, currentUserId, business }) {
  const [drivers, setDrivers] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [areas, setAreas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false);

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
            <HeadingAddButton
              open={adding}
              onPress={() => setAdding((prev) => !prev)}
              label={adding ? 'Cancel adding a driver' : 'Add a driver'}
            />
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

        {drivers.length === 0 ? (
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

      <EntityMapCard
        token={token}
        editableKind="driver"
        home={home}
        drivers={drivers}
        customers={customers}
        areas={areas}
        onChanged={refresh}
        onError={setError}
      />
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

  return (
    <View style={[styles.driverRow, !isFirst && styles.driverRowDivider]}>
      <View style={styles.driverHeader}>
        <View style={styles.driverHeaderText}>
          <Text style={styles.driverName}>{driver.name}</Text>
          <Text style={styles.driverMeta}>{driver.phone}</Text>
        </View>
        <View style={styles.driverHeaderRight}>
          <Pill label={driver.active ? 'active' : 'deactivated'} tone={driver.active ? 'success' : 'neutral'} />
          {/* Reset PIN and Deactivate are rare, one-off actions — showing
              both as standing buttons on every row is exactly the kind
              of always-on weight this merge is meant to remove. One
              small trigger, same disclosure shape used everywhere else
              in this app, rather than a floating menu this stack has no
              proven pattern for. */}
          <Pressable
            onPress={() => setOptionsOpen((prev) => !prev)}
            accessibilityRole="button"
            accessibilityLabel={`Options for ${driver.name}`}
            style={styles.optionsButton}
          >
            <Text style={styles.optionsDots}>⋯</Text>
          </Pressable>
        </View>
      </View>

      {optionsOpen ? (
        resetting ? (
          <View style={styles.resetBox}>
            <Field label="New PIN" size="xs" value={newPin} onChangeText={setNewPin} keyboardType="number-pad" maxLength={6} />
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
              <Button title="Cancel" variant="secondary" onPress={() => setResetting(false)} style={styles.flexButton} />
            </View>
          </View>
        ) : (
          <View style={styles.buttonRow}>
            <Button title="Reset PIN" variant="secondary" onPress={() => setResetting(true)} style={styles.flexButton} />
            {!isSelf ? (
              <Button
                title={driver.active ? 'Deactivate' : 'Reactivate'}
                variant={driver.active ? 'danger' : 'secondary'}
                busy={busy}
                onPress={() => act(() => api.setDriverActive(token, driver.id, !driver.active), () => setOptionsOpen(false))}
                style={styles.flexButton}
              />
            ) : null}
          </View>
        )
      ) : null}

      <View style={styles.homeSection}>
        <Disclosure compact open={editingHome} onToggle={() => setEditingHome((prev) => !prev)}>
          {driver.home_lat || driver.home_lng ? 'Finishes at a saved location' : 'Where does this driver finish?'}
        </Disclosure>
        {editingHome ? (
          <View>
            <Text style={styles.note}>
              A round ends when the driver gets home, not back at the depot — so this changes which stop comes
              last on any route they&apos;re given. Saving it re-orders the route they&apos;re on today.
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
              home={business && (business.home_lat || business.home_lng)
                ? { lat: business.home_lat, lng: business.home_lng }
                : null}
              height={260}
            />
          </View>
        ) : null}
      </View>

      {driver.active ? null : (
        <Text style={styles.note}>
          Deactivated drivers are signed out immediately, including on a phone they still have in their hand.
        </Text>
      )}
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
  optionsDots: { fontSize: 20, fontWeight: '700', color: colors.subtitle, lineHeight: 20 },
  resetBox: { marginTop: spacing.md },
  homeSection: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.xs },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, flexWrap: 'wrap' },
  flexButton: { flex: 1, minWidth: 130 },
});
