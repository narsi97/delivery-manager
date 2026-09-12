import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import { Banner, Button, Card, Field } from '../components';
import { useLanguage } from '../i18n';
import { labelsFor, lower } from '../labels';
import LocationPicker from '../LocationPicker';
import SelectedEntityEditor from '../SelectedEntityEditor';
import { arm, describeUntil, disarm, useDeleteMode, WINDOWS } from '../deleteMode';
import { usePageStyle } from '../layout';
import { colors, radius, spacing } from '../theme';

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
  const labels = labelsFor(business);
  // Which tile is open, if any: 'name' | 'home' | 'password' | 'deleting'.
  const [open, setOpen] = useState(null);
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

  // Four settings, drawn as four tiles rather than four stacked cards —
  // the same shape the Business and Customers tabs use. A page of full
  // width cards, each holding one line of text, spends a screen saying
  // four short things; as tiles they are all in view at once and the one
  // being changed takes the width it needs.
  //
  // Only one opens at a time. These are not things anybody does two of
  // together, and an open map underneath an open password form is two
  // half-finished jobs on one screen.
  const toggle = (which) => setOpen((prev) => (prev === which ? null : which));

  return (
    <ScrollView contentContainerStyle={pageStyle}>
      <Banner message={error} />
      <Banner message={notice} tone="success" />

      <Card>
        <View style={styles.tiles}>
          <BusinessDetailsTiles
            token={token}
            business={business}
            drivers={drivers}
            customers={customers}
            areas={areas}
            open={open}
            onToggle={toggle}
            onSaved={(updated) => {
              setNotice('Business details saved.');
              onBusinessUpdated(updated);
            }}
            onChanged={refresh}
            onError={setError}
          />

          {/* Shut. Three password boxes and a button, standing open on a
              page somebody opened to change their business name, is a
              form for a thing done twice a year taking up the room of
              the things done weekly. See Docs/DESIGN.md. */}
          <SettingTile
            title={t('change_password')}
            value="••••••••"
            open={open === 'password'}
            onPress={() => toggle('password')}
          >
            <ChangePasswordForm token={token} user={user} onNotice={setNotice} onError={setError} />
          </SettingTile>

          <DeleteModeTile
            token={token}
            user={user}
            labels={labels}
            open={open === 'deleting'}
            onToggle={() => toggle('deleting')}
            onUserUpdated={onUserUpdated}
            onNotice={setNotice}
            onError={setError}
          />
        </View>
      </Card>
    </ScrollView>
  );
}

// One setting: its name, what it currently says, and the thing you use
// to change it once you have tapped it.
//
// Closed it is a tile among tiles; open it takes the whole row, because
// a map or a three-field form in a 160-pixel column is not a form. The
// pencil is the same affordance the rest of the app uses for "this line
// is editable" — see CustomerCard.
function SettingTile({ title, value, tone, open, onPress, children }) {
  return (
    <View style={[styles.tile, open && styles.tileOpen, tone === 'danger' && open && styles.tileDanger]}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.tileHead, pressed && styles.pressed]}
      >
        <View style={styles.tileHeadText}>
          <Text style={[styles.tileName, tone === 'danger' && styles.dangerText]}>{title}</Text>
          {value ? <Text style={styles.tileMeta} numberOfLines={1}>{value}</Text> : null}
        </View>
        <Text style={[styles.tilePencil, tone === 'danger' && styles.dangerText]}>{open ? '▾' : '✎'}</Text>
      </Pressable>
      {open ? <View style={styles.tileBody}>{children}</View> : null}
    </View>
  );
}

// Turning the delete buttons on, for a while.
//
// Off is the resting state, and the card says so plainly rather than
// warning about it: somebody who came here to tidy up does not need
// talking out of it, and somebody who did not is not going to switch it
// on by accident. What it does need to say is that the window closes by
// itself, because that is the part that makes leaving it on harmless.
function DeleteModeTile({ token, user, labels, open: shown, onToggle, onUserUpdated, onNotice, onError }) {
  const [me, setMe] = useState(user);
  const [busy, setBusy] = useState(0);
  const { open, until } = useDeleteMode(me);

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

  // Named and coloured for what it is, and shut until asked for.
  // Everything else on this page is reversible; this is the one tile
  // where a wrong press costs something that cannot be got back, so it
  // neither shouts at somebody who came here to change their business
  // name nor hides from somebody who came to tidy up. While the window
  // is running the tile says so on its face, red, without being opened —
  // a screen that hid the fact that deleting is switched on would be the
  // one thing this must never do.
  return (
    <View style={[styles.tile, shown && styles.tileOpen, open && styles.tileArmed]}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityState={{ expanded: shown }}
        style={({ pressed }) => [styles.tileHead, pressed && styles.pressed]}
      >
        <View style={styles.tileHeadText}>
          <Text style={[styles.tileName, open && styles.dangerText]}>Deleting</Text>
          <Text style={[styles.tileMeta, open ? styles.dangerText : styles.dangerSub]}>
            {open ? `On until ${describeUntil(until)}` : 'Danger zone'}
          </Text>
        </View>
        {open ? <Text style={styles.dangerOnPill}>on</Text> : null}
        <Text style={[styles.tilePencil, open && styles.dangerText]}>{shown ? '▾' : '✎'}</Text>
      </Pressable>
      {!shown ? null : open ? (
        <View style={styles.tileBody}>
          <Text style={styles.deleteNote}>
            They turn off by themselves. Deleting takes a customer&apos;s whole history with them, and cannot be undone.
          </Text>
          <Button title="Turn them off now" variant="secondary" onPress={() => set(0)} busy={busy === -1} />
          <ResetEntities token={token} labels={labels} onNotice={onNotice} onError={onError} />
        </View>
      ) : (
        <View style={styles.tileBody}>
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
    </View>
  );
}

// Emptying a whole kind of thing at once.
//
// A business setting up for real does this two or three times — a trial
// import that came out wrong, a list loaded against the wrong round —
// and doing it one customer at a time through thirty-eight
// confirmations is not a fix, it is a punishment.
//
// It is not a factory reset, and says so: the business, what it sells
// and the people who can administer it stay, because those are the ones
// somebody would have to be given back by hand. Two presses, with the
// counts named in between, same as every other delete in this app.
function ResetEntities({ token, labels, onNotice, onError }) {
  const [picked, setPicked] = useState({});
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  const kinds = [
    { key: 'customers', label: labels.customer_plural },
    { key: 'service_areas', label: `Service ${lower(labels.route)}s` },
    { key: 'drivers', label: `${labels.driver}s` },
  ];
  const chosen = kinds.filter((kind) => picked[kind.key]);

  const run = async () => {
    setBusy(true);
    try {
      const result = await api.resetEntities(token, {
        customers: !!picked.customers,
        drivers: !!picked.drivers,
        service_areas: !!picked.service_areas,
      });
      const said = Object.entries(result.removed || {})
        .filter(([, n]) => n > 0)
        .map(([kind, n]) => `${n} ${kind.replace('_', ' ')}`)
        .join(', ');
      onNotice(said ? `Cleared ${said}.` : 'Nothing to clear.');
      setPicked({});
      setAsking(false);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.resetBlock}>
      <Text style={styles.resetTitle}>Start over</Text>
      <View style={styles.resetKinds}>
        {kinds.map((kind) => {
          const on = !!picked[kind.key];
          return (
            <Pressable
              key={kind.key}
              onPress={() => {
                setAsking(false);
                setPicked((prev) => ({ ...prev, [kind.key]: !prev[kind.key] }));
              }}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`Clear all ${kind.label.toLowerCase()}`}
              style={({ pressed }) => [styles.resetKind, on && styles.resetKindOn, pressed && styles.pressed]}
            >
              <Text style={[styles.resetKindText, on && styles.resetKindTextOn]}>
                {on ? '✓ ' : ''}
                {kind.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {chosen.length === 0 ? null : asking ? (
        <View>
          <Text style={styles.resetWarning}>
            All {chosen.map((kind) => kind.label.toLowerCase()).join(' and ')} in this business, and everything that
            belongs to them. This cannot be undone.
          </Text>
          <View style={styles.resetButtons}>
            <Button title="Yes, clear them" variant="danger" onPress={run} busy={busy} style={styles.flexButton} />
            <Button title="Keep them" variant="secondary" onPress={() => setAsking(false)} style={styles.flexButton} />
          </View>
        </View>
      ) : (
        <Button
          title={`Clear ${chosen.map((kind) => kind.label.toLowerCase()).join(' and ')}`}
          variant="danger"
          onPress={() => setAsking(true)}
        />
      )}
      <Text style={styles.resetKeeps}>
        Keeps what you sell, and anyone who can manage the business.
      </Text>
    </View>
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
      {/* The one thing on this page somebody has to be told: there is
          no email on file, so nothing can send them a reset link. */}
      <Text style={styles.note}>No password reset — keep it somewhere safe.</Text>
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
function BusinessDetailsTiles({ token, business, drivers, customers, areas, open, onToggle, onSaved, onError, onChanged }) {
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
      onToggle('name');
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
    <>
      <SettingTile
        title="Business name"
        value={business.name}
        open={open === 'name'}
        onPress={() => onToggle('name')}
      >
        <Field label="Business name" size="md" value={name} onChangeText={setName} placeholder="Anita's Dairy" />
        <View style={styles.buttonRow}>
          <Button title="Save" onPress={saveName} busy={busy} disabled={!name.trim()} style={styles.flexButton} />
          <Button
            title="Cancel"
            variant="secondary"
            onPress={() => {
              setName(business.name);
              onToggle('name');
            }}
            style={styles.flexButton}
          />
        </View>
      </SettingTile>

      <SettingTile
        title="Where you're based"
        value={hasHome ? 'Pinned on the map' : 'Not set yet'}
        open={open === 'home'}
        onPress={() => onToggle('home')}
      >
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
      </SettingTile>
    </>
  );
}

const styles = StyleSheet.create({
  // The same tiles the Business and Customers tabs are built from.
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tile: {
    flexGrow: 1,
    flexBasis: 200,
    minWidth: 0,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.sm,
  },
  // Open, it stops being a tile: it is a form, and a form needs the row.
  tileOpen: { flexBasis: '100%' },
  tileArmed: { borderColor: colors.error },
  tileDanger: { borderColor: colors.error },
  tileHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, minHeight: 40 },
  tileHeadText: { flex: 1, minWidth: 0 },
  tileName: { fontSize: 15, fontWeight: '700', color: colors.text },
  tileMeta: { fontSize: 12, color: colors.subtitle, marginTop: 1 },
  tilePencil: { fontSize: 18, lineHeight: 20, color: colors.link, width: 22, textAlign: 'center' },
  tileBody: { marginTop: spacing.sm },
  dangerText: { color: colors.error },
  resetBlock: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
  resetTitle: { fontSize: 14, fontWeight: '700', color: colors.text, marginBottom: spacing.sm },
  resetKinds: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  resetKind: {
    paddingVertical: 7,
    paddingHorizontal: spacing.md,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  resetKindOn: { borderColor: colors.error, backgroundColor: colors.errorBg },
  resetKindText: { fontSize: 13, fontWeight: '600', color: colors.text },
  resetKindTextOn: { color: colors.error },
  resetWarning: { fontSize: 13, fontWeight: '700', color: colors.error, lineHeight: 18, marginBottom: spacing.sm },
  resetButtons: { flexDirection: 'row', gap: spacing.sm },
  resetKeeps: { fontSize: 12, color: colors.subtitle, marginTop: spacing.sm },
  // Says what kind of tile this is without taking the heading's job.
  dangerSub: { fontWeight: '700', color: colors.error },
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
