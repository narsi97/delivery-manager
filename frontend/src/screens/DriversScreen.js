import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import { AddButton, Banner, Button, Card, Disclosure, Empty, Field, Pill, SectionTitle, ViewToggle } from '../components';
import EntityMapPanel from '../EntityMapPanel';
import LocationPicker, { InlineLocationEditor } from '../LocationPicker';
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
          after={
            <AddButton
              open={adding}
              onPress={() => setAdding((prev) => !prev)}
              label={adding ? 'Cancel adding a driver' : 'Add a driver'}
            />
          }
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
            </View>
          }
        >
          Drivers ({drivers.length})
        </SectionTitle>
        <View style={styles.headingDivider} />

        {adding ? (
          <NewDriverForm
            token={token}
            onCreated={async (name) => {
              setNotice(`${name} can now sign in with their phone number.`);
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
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.createDriver(token, { name, phone });
      const created = name;
      setName('');
      setPhone('');
      await onCreated(created);
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
      <Button title="Add driver" onPress={submit} busy={busy} disabled={!name.trim() || !phone.trim()} />
      <Text style={styles.note}>
        They sign in with this number and a code sent to it — nothing for you to issue, tell them, or reset.
      </Text>
    </View>
  );
}

// One driver, as a row inside the shared Drivers card rather than a card
// of its own — see the "keep them together" note on DriversScreen above.
// A divider stands in for the border every separate Card used to draw,
// so three drivers still read as three distinct records without three
// boxes of whitespace between them.
function DriverRow({ driver, token, business, isSelf, isFirst, onChanged, onError, onNotice }) {
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [editingHome, setEditingHome] = useState(false);
  const [busy, setBusy] = useState(false);
  const [finishAt, setFinishAt] = useState(driver.finish_at || 'farm');
  const [customPin, setCustomPin] = useState({ lat: driver.finish_lat || 0, lng: driver.finish_lng || 0 });
  // Blank means no limit, which is what most drivers are — so it stays
  // blank rather than being pre-filled with a number to think about.
  const [maxStops, setMaxStops] = useState(driver.max_stops ? String(driver.max_stops) : '');

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
  const finishLabel =
    { farm: 'finishes at the farm', home: 'finishes at home', custom: 'finishes at a set place' }[
      driver.finish_at || 'farm'
    ];

  const saveFinish = (choice, pin) =>
    act(
      () => api.setDriverFinish(token, driver.id, choice, pin?.lat, pin?.lng),
      () => onNotice(`${driver.name} now ${{ farm: 'finishes at the farm', home: 'finishes at home', custom: 'finishes at the pin you set' }[choice]}.`)
    );
  // One line of context under the name, rather than a standing disclosure
  // row per driver. Whether a finish point exists is worth seeing at a
  // glance; the map to change it is not.
  const meta = [driver.phone, finishLabel, driver.max_stops ? `up to ${driver.max_stops} a round` : '']
    .filter(Boolean)
    .join(' · ');

  const saveMaxStops = () => {
    const parsed = Number(maxStops);
    const next = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
    if (next === (driver.max_stops || 0)) {
      return;
    }
    return act(
      () => api.setDriverMaxStops(token, driver.id, next),
      () =>
        onNotice(
          next === 0
            ? `${driver.name} has no delivery limit.`
            : `${driver.name} will take at most ${next} deliveries a round.`,
        ),
    );
  };

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
          finish, whether they are active. All of it is rare
          next to how often this list is read, and showing any of it
          standing made every driver look like a settings panel — three
          drivers became a wall of identical horizontal rules with no way
          to tell which line separated two people and which sat inside
          one. Nested and tinted so it reads as belonging to the name
          above it rather than as the next entry down. */}
      {optionsOpen ? (
        <View style={styles.optionsPanel}>
          <View>
              {/* Where the round ends. The farm is the default and the
                  usual answer — undelivered stock and empty bottles have
                  to be handed over, and that cannot happen at the
                  driver's house. */}
              <Text style={styles.finishLabel}>Where does this route end?</Text>
              <View style={styles.finishRow}>
                {[
                  { value: 'farm', label: 'The farm' },
                  { value: 'home', label: 'Their home' },
                  { value: 'custom', label: 'Somewhere else' },
                ].map((option) => {
                  const on = finishAt === option.value;
                  return (
                    <Pressable
                      key={option.value}
                      onPress={() => {
                        setFinishAt(option.value);
                        // Custom needs a pin before it can be saved, so
                        // choosing it opens the map instead of saving a
                        // setting that cannot be honoured.
                        if (option.value !== 'custom') {
                          saveFinish(option.value);
                        }
                      }}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      style={[styles.finishChip, on && styles.finishChipOn]}
                    >
                      <Text style={[styles.finishChipText, on && styles.finishChipTextOn]}>{option.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
              {finishAt === 'home' && !hasHome ? (
                <Text style={styles.note}>
                  No home pinned yet, so this route will end wherever the last stop is. Set it below.
                </Text>
              ) : null}

              {finishAt === 'custom' ? (
                <View style={styles.homeEditor}>
                  <InlineLocationEditor
                    lat={customPin.lat}
                    lng={customPin.lng}
                    onSave={async (lat, lng) => {
                      setCustomPin({ lat, lng });
                      await saveFinish('custom', { lat, lng });
                    }}
                    home={
                      business && (business.home_lat || business.home_lng)
                        ? { lat: business.home_lat, lng: business.home_lng }
                        : null
                    }
                    height={220}
                  />
                </View>
              ) : null}

              {/* How much the van holds. A limit belongs to the driver
                  rather than to today, so a morning that has to be
                  shared out is a number typed once and not a decision
                  re-made every day. Anything past it stays unassigned
                  and shows on Today as not going out. */}
              <Text style={[styles.finishLabel, styles.spacedLabel]}>How many deliveries can they take?</Text>
              <View style={styles.maxRow}>
                <input
                  type="number"
                  min={1}
                  value={maxStops}
                  placeholder="no limit"
                  aria-label={`Most deliveries for ${driver.name} in one round`}
                  onChange={(event) => setMaxStops(event.target.value)}
                  onBlur={saveMaxStops}
                  style={maxInputStyle}
                />
                <Button title="Save" variant="secondary" onPress={saveMaxStops} busy={busy} />
              </View>
              <Text style={styles.note}>
                Leave it blank if their van takes whatever the round has.
              </Text>

              <Disclosure compact open={editingHome} onToggle={() => setEditingHome((prev) => !prev)}>
                {hasHome ? 'Change where they live' : 'Set where they live'}
              </Disclosure>
              {editingHome ? (
                <View style={styles.homeEditor}>
                  <Text style={styles.note}>
                    A route ends when the driver gets home, not back at the depot — so this changes which stop
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

              {/* No "reset PIN" any more — there is no PIN. A driver who
                  can't get in asks for a code like anyone else, which is
                  one fewer secret for the owner to be responsible for. */}
              <View style={styles.buttonRow}>
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
        </View>
      ) : null}
    </View>
  );
}

// A raw input rather than Field: this is a number beside a button on one
// line, not a labelled form row, and Field's block layout would give it a
// paragraph of its own. Same treatment as the caps on the Today card.
const maxInputStyle = {
  width: 110,
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: radius.md,
  paddingTop: 8,
  paddingBottom: 8,
  paddingLeft: spacing.sm,
  paddingRight: spacing.sm,
  fontSize: 15,
  color: colors.text,
  backgroundColor: colors.surface,
  fontFamily: 'inherit',
};

const styles = StyleSheet.create({
  page: { padding: spacing.lg, maxWidth: 720, width: '100%', alignSelf: 'center' },
  maxRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: 2 },
  loader: { marginTop: spacing.xl * 2 },
  note: { fontSize: 12, color: colors.hint, marginTop: spacing.sm, lineHeight: 17 },
  headingDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginTop: -spacing.sm,
    marginBottom: spacing.md,
  },
  inlineForm: { marginBottom: spacing.md },
  headingActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  finishLabel: { fontSize: 13, fontWeight: '600', color: colors.label, marginBottom: spacing.xs },
  spacedLabel: { marginTop: spacing.md },
  finishRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  finishChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    minHeight: 40,
    justifyContent: 'center',
  },
  finishChipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  finishChipText: { fontSize: 13, fontWeight: '600', color: colors.label },
  finishChipTextOn: { color: colors.accentText },
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
