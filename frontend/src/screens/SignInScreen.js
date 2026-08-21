import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import { Banner, Button, Card, Field } from '../components';
import { getFrontendConfig } from '../config/environments';
import GoogleSignInButton from '../GoogleSignInButton';
import { colors, radius, spacing } from '../theme';

const BUSINESS_TYPES = [
  { value: 'dairy', label: 'Dairy / milk' },
  { value: 'school', label: 'School transport' },
  { value: 'grocery', label: 'Grocery' },
  { value: 'water', label: 'Water' },
  { value: 'other', label: 'Other' },
];

// Two audiences, one screen. The admin half is a Google sign-in; the
// driver half is a phone number and a PIN, because a delivery driver is
// staff created by their employer, not a self-service signup. Which half
// you land on defaults to admin, since a driver signs in once and then
// stays signed in for a fortnight (see the prod TOKEN_TTL_HOURS).
export default function SignInScreen({ onSession }) {
  const [mode, setMode] = useState('admin');

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.header}>
        <Text style={styles.title}>Delivery Manager</Text>
        <Text style={styles.subtitle}>Recurring deliveries, optimized rounds, one app.</Text>
      </View>

      <View style={styles.tabs}>
        <Tab label="Business admin" active={mode === 'admin'} onPress={() => setMode('admin')} />
        <Tab label="Driver" active={mode === 'driver'} onPress={() => setMode('driver')} />
      </View>

      {mode === 'admin' ? <AdminSignIn onSession={onSession} /> : <DriverSignIn onSession={onSession} />}
    </ScrollView>
  );
}

function Tab({ label, active, onPress }) {
  return (
    <Pressable onPress={onPress} style={[styles.tab, active && styles.tabActive]} accessibilityRole="tab">
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

function AdminSignIn({ onSession }) {
  const { googleClientId, environment } = getFrontendConfig();
  const [creating, setCreating] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [businessType, setBusinessType] = useState('dairy');
  const [timezone, setTimezone] = useState(guessTimezone());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // One Google credential, two destinations. Which endpoint it goes to
  // depends on whether the admin is registering a new business or
  // signing in to an existing one — the backend deliberately refuses to
  // guess (see handleGoogleSignIn's signup_required).
  const handleCredential = async (credential) => {
    setError('');
    setBusy(true);
    try {
      const session = creating
        ? await api.signUpBusiness(credential, businessName, businessType, timezone)
        : await api.googleSignIn(credential);
      onSession(session);
    } catch (err) {
      if (err.code === 'signup_required') {
        setError('No business is registered to that Google account yet. Switch to "Create a business" below.');
        setCreating(true);
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDevLogin = async () => {
    setError('');
    setBusy(true);
    try {
      onSession(await api.devLogin());
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Banner message={error} />

      <View style={styles.switchRow}>
        <Pressable onPress={() => setCreating(false)} style={[styles.switch, !creating && styles.switchActive]}>
          <Text style={[styles.switchText, !creating && styles.switchTextActive]}>Sign in</Text>
        </Pressable>
        <Pressable onPress={() => setCreating(true)} style={[styles.switch, creating && styles.switchActive]}>
          <Text style={[styles.switchText, creating && styles.switchTextActive]}>Create a business</Text>
        </Pressable>
      </View>

      {creating ? (
        <View>
          <Field
            label="Business name"
            value={businessName}
            onChangeText={setBusinessName}
            placeholder="Sri Lakshmi Dairy"
          />
          <Text style={styles.label}>What do you deliver?</Text>
          <View style={styles.chipRow}>
            {BUSINESS_TYPES.map((type) => (
              <Pressable
                key={type.value}
                onPress={() => setBusinessType(type.value)}
                style={[styles.chip, businessType === type.value && styles.chipActive]}
              >
                <Text style={[styles.chipText, businessType === type.value && styles.chipTextActive]}>
                  {type.label}
                </Text>
              </Pressable>
            ))}
          </View>
          <Field
            label="Timezone"
            value={timezone}
            onChangeText={setTimezone}
            autoCapitalize="none"
            hint="Delivery days roll over on this clock, not your phone's."
          />
        </View>
      ) : null}

      {googleClientId ? (
        <View style={styles.googleRow}>
          <GoogleSignInButton onCredential={handleCredential} />
        </View>
      ) : (
        <Text style={styles.note}>
          Google Sign-In isn&apos;t configured on this server. Set EXPO_PUBLIC_GOOGLE_CLIENT_ID (frontend) and
          GOOGLE_CLIENT_ID (backend) to enable admin accounts.
        </Text>
      )}

      {environment !== 'prod' ? (
        <Button
          title="Continue as local dev admin"
          variant="secondary"
          onPress={handleDevLogin}
          busy={busy}
          style={styles.devButton}
        />
      ) : null}
    </Card>
  );
}

function DriverSignIn({ onSession }) {
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      onSession(await api.driverSignIn(phone, pin));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Banner message={error} />
      <Field
        label="Phone number"
        value={phone}
        onChangeText={setPhone}
        placeholder="98765 43210"
        keyboardType="phone-pad"
        autoComplete="tel"
      />
      <Field
        label="PIN"
        value={pin}
        onChangeText={setPin}
        placeholder="6 digits"
        keyboardType="number-pad"
        secureTextEntry
        maxLength={6}
      />
      <Button title="Start my round" onPress={submit} busy={busy} disabled={!phone || pin.length < 6} />
      <Text style={styles.note}>Your PIN comes from whoever manages your deliveries. Ask them to reset it if you forget.</Text>
    </Card>
  );
}

// guessTimezone gives the signup form a sensible default from the browser.
// The value is still editable, because the person setting a business up is
// not always sitting in the same timezone as the round.
function guessTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
  } catch (error) {
    return 'Asia/Kolkata';
  }
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, maxWidth: 520, width: '100%', alignSelf: 'center' },
  header: { marginTop: spacing.xl, marginBottom: spacing.lg },
  title: { fontSize: 28, fontWeight: '800', color: colors.text },
  subtitle: { fontSize: 15, color: colors.subtitle, marginTop: spacing.xs },
  tabs: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  tab: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    backgroundColor: colors.surface,
  },
  tabActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  tabText: { fontWeight: '700', color: colors.label },
  tabTextActive: { color: colors.accentText },
  switchRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.lg },
  switch: { flex: 1, paddingVertical: spacing.sm, borderRadius: radius.sm, alignItems: 'center', backgroundColor: colors.surfaceAlt },
  switchActive: { backgroundColor: colors.text },
  switchText: { fontSize: 13, fontWeight: '600', color: colors.label },
  switchTextActive: { color: colors.surface },
  label: { fontSize: 13, fontWeight: '600', color: colors.label, marginBottom: spacing.xs },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { fontSize: 13, color: colors.label, fontWeight: '600' },
  chipTextActive: { color: colors.accentText },
  googleRow: { alignItems: 'center', marginTop: spacing.sm },
  devButton: { marginTop: spacing.md },
  note: { fontSize: 12, color: colors.hint, marginTop: spacing.md, lineHeight: 17 },
});
