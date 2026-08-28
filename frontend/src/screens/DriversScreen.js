import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import { Banner, Button, Card, Disclosure, Empty, Field, Pill, SectionTitle } from '../components';
import { colors, spacing } from '../theme';

export default function DriversScreen({ token, currentUserId }) {
  const [drivers, setDrivers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    try {
      const driverResponse = await api.listDrivers(token);
      setDrivers(driverResponse.drivers || []);
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

      <NewDriverCard
        token={token}
        onCreated={async (name, pin) => {
          setNotice(`${name} can now sign in with their phone number and the PIN ${pin}.`);
          await refresh();
        }}
        onError={setError}
      />

      <SectionTitle>Drivers ({drivers.length})</SectionTitle>
      {drivers.length === 0 ? (
        <Card>
          <Empty>No drivers yet.</Empty>
        </Card>
      ) : (
        drivers.map((driver) => (
          <DriverCard
            key={driver.id}
            driver={driver}
            token={token}
            isSelf={driver.id === currentUserId}
            onChanged={refresh}
            onError={setError}
            onNotice={setNotice}
          />
        ))
      )}
    </ScrollView>
  );
}

// Collapsed by default — same expand-on-tap shape as Customers'
// "Add a customer": an admin adds a driver rarely compared to how often
// they glance at the roster below, so the form shouldn't be the first
// thing on screen every visit.
function NewDriverCard({ token, onCreated, onError }) {
  const [expanded, setExpanded] = useState(false);
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
      setExpanded(false);
      await onCreated(created.name, created.pin);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Disclosure open={expanded} onToggle={() => setExpanded((prev) => !prev)}>
        Add a driver
      </Disclosure>

      {expanded ? (
        <View>
          <Field label="Name" size="md" value={name} onChangeText={setName} placeholder="Ravi Kumar" />
          <Field label="Phone number" size="sm" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="98765 43210" />
          <Field
            label="PIN"
            value={pin}
            onChangeText={setPin}
            keyboardType="number-pad"
            maxLength={6}
            placeholder="6 digits"
            hint="Not all the same digit, and not a run like 123456. Tell the driver this PIN — you won't be able to read it back."
          />
          <Button title="Add driver" onPress={submit} busy={busy} disabled={!name.trim() || !phone.trim() || pin.length !== 6} />
          <Text style={styles.note}>
            Drivers sign in with their phone number and this PIN — no Google account and no email needed.
          </Text>
        </View>
      ) : null}
    </Card>
  );
}

function DriverCard({ driver, token, isSelf, onChanged, onError, onNotice }) {
  const [resetting, setResetting] = useState(false);
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
    <Card>
      <View style={styles.driverHeader}>
        <View style={styles.driverHeaderText}>
          <Text style={styles.driverName}>{driver.name}</Text>
          <Text style={styles.driverMeta}>{driver.phone}</Text>
        </View>
        <Pill label={driver.active ? 'active' : 'deactivated'} tone={driver.active ? 'success' : 'neutral'} />
      </View>

      {resetting ? (
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
              onPress={() => act(() => api.setDriverActive(token, driver.id, !driver.active))}
              style={styles.flexButton}
            />
          ) : null}
        </View>
      )}

      {driver.active ? null : (
        <Text style={styles.note}>
          Deactivated drivers are signed out immediately, including on a phone they still have in their hand.
        </Text>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, maxWidth: 720, width: '100%', alignSelf: 'center' },
  loader: { marginTop: spacing.xl * 2 },
  note: { fontSize: 12, color: colors.hint, marginTop: spacing.sm, lineHeight: 17 },
  driverHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  driverHeaderText: { flex: 1 },
  driverName: { fontSize: 16, fontWeight: '700', color: colors.text },
  driverMeta: { fontSize: 13, color: colors.subtitle, marginTop: 2 },
  resetBox: { marginTop: spacing.md },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, flexWrap: 'wrap' },
  flexButton: { flex: 1, minWidth: 130 },
});
