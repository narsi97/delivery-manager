import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import { Banner, Button, Card, Disclosure, Field, SectionTitle } from '../components';
import { useLanguage } from '../i18n';
import LocationPicker from '../LocationPicker';
import { arm, describeUntil, disarm, useDeleteMode, WINDOWS } from '../deleteMode';
import { usePageStyle } from '../layout';
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
export default function AccountScreen({ token, business, user, onBusinessUpdated, onUserUpdated }) {
  const pageStyle = usePageStyle(720);
  const [changingPassword, setChangingPassword] = useState(false);
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
    <ScrollView contentContainerStyle={pageStyle}>
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

      {/* Closed. Three password boxes and a button, standing open on a
          page somebody opened to change their business name, is a form
          for a thing done twice a year taking up the room of the things
          done weekly. See Docs/DESIGN.md. */}
      <Card>
        <Disclosure open={changingPassword} onToggle={() => setChangingPassword((prev) => !prev)}>
          {t('change_password')}
        </Disclosure>
        {changingPassword ? (
          <ChangePasswordForm token={token} user={user} onNotice={setNotice} onError={setError} />
        ) : null}
      </Card>

      <DeleteModeCard token={token} user={user} onUserUpdated={onUserUpdated} onNotice={setNotice} onError={setError} />
    </ScrollView>
  );
}

// Turning the delete buttons on, for a while.
//
// Off is the resting state, and the card says so plainly rather than
// warning about it: somebody who came here to tidy up does not need
// talking out of it, and somebody who did not is not going to switch it
// on by accident. What it does need to say is that the window closes by
// itself, because that is the part that makes leaving it on harmless.
function DeleteModeCard({ token, user, onUserUpdated, onNotice, onError }) {
  const [me, setMe] = useState(user);
  const [busy, setBusy] = useState(0);
  const { open, until } = useDeleteMode(me);
  // Opened by hand, or already open because the window is running — a
  // card that hides the fact that deleting is switched on would be the
  // one thing this card must never do.
  const [shown, setShown] = useState(open);

  const set = async (hours) => {
    setBusy(hours || -1);
    try {
      const updated = await (hours ? arm(token, hours) : disarm(token));
      setMe(updated);
      if (onUserUpdated) {
        onUserUpdated(updated);
      }
      onNotice(hours ? 'Delete buttons are on.' : 'Delete buttons are off.');
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(0);
    }
  };

  return (
    <Card style={open ? styles.dangerCard : null}>
      {/* Named and coloured for what it is, and shut until asked for.
          Everything else on this page is reversible; this is the one
          card where a wrong press costs something that cannot be got
          back, so it neither shouts at somebody who came here to change
          their business name nor hides from somebody who came to tidy
          up. Open, it is red, because then it is armed. */}
      <Pressable
        onPress={() => setShown((prev) => !prev)}
        accessibilityRole="button"
        accessibilityState={{ expanded: shown }}
        style={({ pressed }) => [styles.dangerHead, pressed && styles.pressed]}
      >
        <View style={styles.dangerHeadText}>
          <Text style={styles.dangerTitle}>Deleting</Text>
          <Text style={styles.dangerSub}>Danger zone</Text>
        </View>
        {open ? <Text style={styles.dangerOnPill}>on</Text> : null}
        <Text style={[styles.dangerChevron, open && styles.dangerTitleArmed]}>{shown ? '▾' : '▸'}</Text>
      </Pressable>
      {!shown ? null : open ? (
        <View>
          <Text style={styles.deleteOn}>Delete buttons are on until {describeUntil(until)}.</Text>
          <Text style={styles.deleteNote}>
            They turn off by themselves. Deleting takes a customer&apos;s whole history with them, and cannot be undone.
          </Text>
          <Button title="Turn them off now" variant="secondary" onPress={() => set(0)} busy={busy === -1} />
        </View>
      ) : (
        <View>
          <Text style={styles.deleteNote}>
            Nothing can be deleted while this is off. Turn it on to tidy up, and it turns itself back off.
          </Text>
          <View style={styles.deleteWindows}>
            {WINDOWS.map((window) => (
              <Button
                key={window.hours}
                title={window.label}
                variant="secondary"
                onPress={() => set(window.hours)}
                busy={busy === window.hours}
                style={styles.deleteWindow}
              />
            ))}
          </View>
        </View>
      )}
    </Card>
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
  dangerCard: { borderColor: colors.error },
  dangerHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44 },
  dangerHeadText: { flex: 1 },
  dangerTitle: { fontSize: 17, fontWeight: '700', color: colors.text },
  // Says what kind of card this is without taking the heading's job.
  dangerSub: { fontSize: 12, fontWeight: '700', color: colors.error, marginTop: 1 },
  dangerTitleArmed: { color: colors.error },
  dangerChevron: { fontSize: 20, fontWeight: '700', color: colors.link, width: 20, textAlign: 'center' },
  dangerOnPill: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.error,
    backgroundColor: colors.errorBg,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: 'hidden',
  },
  pressed: { opacity: 0.6 },
  deleteOn: { fontSize: 14, fontWeight: '700', color: colors.error, marginBottom: spacing.xs },
  deleteNote: { fontSize: 13, color: colors.subtitle, lineHeight: 18, marginBottom: spacing.md },
  deleteWindows: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  deleteWindow: { flexGrow: 1, minWidth: 96 },
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
