import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import { Banner, Button, Card, Field, SectionTitle } from '../components';
import { useLanguage } from '../i18n';
import LocationPicker from '../LocationPicker';
import { colors, spacing } from '../theme';

// Everything about the account rather than about the deliveries.
//
// The business's name and where it is based used to sit at the top of
// the Business tab, above the products and the service routes. They are
// set once and almost never touched, and having them first meant the tab
// an owner opens to check stock led with two things that never change.
// The password lived in the account menu, which is a menu — fine for
// "sign out", wrong for a form with three fields in it.
//
// So they are together here, in one place called what it is, and the
// Business tab is products and routes: the things a dairy actually
// works on.
export default function AccountScreen({ token, business, user, onBusinessUpdated }) {
  const { t } = useLanguage();
  const [drivers, setDrivers] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [areas, setAreas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // The business's own map shows its customers and drivers for context
  // when the owner is placing the pin — the same reference points the
  // rest of the app's maps use.
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

      <BusinessDetailsCard
        token={token}
        business={business}
        drivers={drivers}
        customers={customers}
        areas={areas}
        onSaved={(updated) => {
          setNotice('Business details saved.');
          onBusinessUpdated(updated);
        }}
        onChanged={refresh}
        onError={setError}
      />

      <Card>
        <SectionTitle>{t('change_password')}</SectionTitle>
        <View style={styles.headingDivider} />
        <ChangePasswordForm token={token} user={user} onNotice={setNotice} onError={setError} />
      </Card>
    </ScrollView>
  );
}

// Changing your own.
//
// The current one is required, so a phone left unlocked on a van seat
// cannot be used to lock its owner out of their own business. An account
// that has never had one — a driver added before passwords existed —
// sets it instead; the server decides that, not this form.
function ChangePasswordForm({ token, user, onNotice, onError }) {
  const { t } = useLanguage();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;

  const submit = async () => {
    setBusy(true);
    onError('');
    try {
      await api.changePassword(token, current, next);
      onNotice(t('password_changed'));
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <Text style={styles.note}>
        You sign in with {user?.phone || 'your phone number'} and this password. There is no way to email you a
        reset, so keep it somewhere safe.
      </Text>
      <Field
        label={t('current_password')}
        size="md"
        value={current}
        onChangeText={setCurrent}
        secureTextEntry
        placeholder="••••••"
      />
      <Field
        label={t('new_password')}
        size="md"
        value={next}
        onChangeText={setNext}
        secureTextEntry
        placeholder="at least 6 characters"
      />
      {/* Typed twice, because a password you cannot read back and cannot
          have reset is one you only find out you mistyped when you are
          locked out. */}
      <Field
        label={t('confirm_password')}
        size="md"
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry
        placeholder="••••••"
        hint={mismatch ? t('passwords_do_not_match') : undefined}
      />
      <Button
        title={t('change_password')}
        onPress={submit}
        busy={busy}
        disabled={next.length < 6 || next !== confirm}
      />
    </View>
  );
}

// Read-only by default (name + a pencil) — an admin sets this once and
// almost never touches it again, so an always-open Field+Save fights for
// attention every single visit for no reason. Same "collapsed until
// asked for" idea as NewCustomerCard's "+ Add", just applied to editing
// an existing value instead of creating a new one.
// The business itself: what it's called and where it's based. One card,
// because they are one subject — a business owner thinking "let me check
// our details" is thinking about both, and splitting them across two
// boxes made the screen read as a list of settings rather than a record
// of the business.
//
// Each half still opens on its own: the name behind a pencil, the
// location behind its summary. They're set once and rarely touched, so
// neither should sit open as a form every visit.
function BusinessDetailsCard({ token, business, drivers, customers, areas, onSaved, onError, onChanged }) {
  const [editingName, setEditingName] = useState(false);
  const [editingHome, setEditingHome] = useState(false);
  const [name, setName] = useState(business.name);
  const [busy, setBusy] = useState(false);
  const hasHome = business.home_lat || business.home_lng;
  // Whichever customer or driver was last tapped on this map — this is
  // the one map in the app where every entity is manageable, not just
  // the one kind a screen owns, so tapping a customer here opens their
  // location editor right where it was tapped rather than sending the
  // admin off to the Customers tab to do it.
  const [selected, setSelected] = useState(null);

  const saveName = async () => {
    setBusy(true);
    try {
      onSaved(await api.updateBusiness(token, { name }));
      setEditingName(false);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Autosaves per click/drag — the business record already exists, so
  // there's nothing to buffer-and-submit, same as CustomerCard's pin
  // editor for an existing customer.
  const savePin = async (lat, lng) => {
    try {
      onSaved(await api.updateBusiness(token, { home_lat: lat, home_lng: lng }));
    } catch (err) {
      onError(err.message);
    }
  };

  return (
    <Card>
      {editingName ? (
        <View>
          <Field label="Business name" size="md" value={name} onChangeText={setName} placeholder="Anita's Dairy" />
          <View style={styles.buttonRow}>
            <Button title="Save" onPress={saveName} busy={busy} disabled={!name.trim()} style={styles.flexButton} />
            <Button
              title="Cancel"
              variant="secondary"
              onPress={() => {
                setName(business.name);
                setEditingName(false);
              }}
              style={styles.flexButton}
            />
          </View>
        </View>
      ) : (
        <Pressable onPress={() => setEditingName(true)} accessibilityRole="button">
          <View style={styles.readRow}>
            <View style={styles.readRowText}>
              <Text style={styles.readLabel}>Business name</Text>
              <Text style={styles.readValue}>{business.name}</Text>
            </View>
            <Text style={styles.pencil}>✎</Text>
          </View>
        </Pressable>
      )}

      <View style={styles.cardSection}>
        {editingHome ? (
          <View>
            <View style={styles.editHeader}>
              <Text style={styles.readLabel}>Where you&apos;re based</Text>
              <Pressable onPress={() => setEditingHome(false)} accessibilityRole="button">
                <Text style={styles.doneLink}>Done</Text>
              </Pressable>
            </View>
            <LocationPicker
              label="The depot, the shop, the dairy"
              hint="Routes start here, and every map in the app opens on the area around it. Tap a customer or driver on the map to manage them."
              lat={business.home_lat}
              lng={business.home_lng}
              onChange={savePin}
              areas={areas}
              drivers={drivers}
              customers={customers}
              height={320}
              onSelectReference={setSelected}
            />
            {selected ? (
              <SelectedEntityEditor
                key={`${selected.kind}-${selected.data.id}`}
                token={token}
                selected={selected}
                home={{ lat: business.home_lat, lng: business.home_lng }}
                onClose={() => setSelected(null)}
                onChanged={async () => {
                  await onChanged();
                  setSelected(null);
                }}
                onError={onError}
              />
            ) : null}
          </View>
        ) : (
          <Pressable onPress={() => setEditingHome(true)} accessibilityRole="button">
            <View style={styles.readRow}>
              <View style={styles.readRowText}>
                <Text style={styles.readLabel}>Where you&apos;re based</Text>
                <Text style={styles.readValue}>{hasHome ? 'Pinned on the map' : 'Not set yet'}</Text>
              </View>
              <Text style={styles.pencil}>✎</Text>
            </View>
          </Pressable>
        )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, maxWidth: 720, width: '100%', alignSelf: 'center' },
  loader: { marginTop: spacing.xl * 2 },
  headingDivider: {
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginTop: -spacing.sm,
    marginBottom: spacing.md,
  },
  cardSection: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.xs },
  editHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  doneLink: { fontSize: 14, fontWeight: '700', color: colors.link },
  pencil: { fontSize: 16, color: colors.link },
  readRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  readRowText: { flex: 1, paddingRight: spacing.sm },
  readLabel: { fontSize: 12, fontWeight: '600', color: colors.hint, textTransform: 'uppercase', letterSpacing: 0.04 },
  readValue: { fontSize: 16, fontWeight: '700', color: colors.text, marginTop: 2 },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', marginTop: spacing.sm },
  flexButton: { flex: 1, minWidth: 110 },
  note: { fontSize: 12, color: colors.hint, marginBottom: spacing.sm, lineHeight: 17 },
});
