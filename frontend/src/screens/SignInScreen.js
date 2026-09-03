import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from '../api';
import { Banner, Button, Field } from '../components';
import { getFrontendConfig } from '../config/environments';
import { useLanguage } from '../i18n';
import LanguageSwitcher from '../LanguageSwitcher';
import { colors, radius, spacing } from '../theme';

// One door, for everyone.
//
// This screen used to have two tabs — "Business admin", who signed in
// with Google, and "Driver", who typed a phone number and a PIN their
// employer had issued them. Both are gone: everyone types a phone number
// now, so the app no longer needs to ask who you are before it can let
// you in. It finds out from the number.
//
// The second half of that pair is a password, not the one-time code the
// product was designed around. Nothing about the code path is deleted —
// api.requestOTP and api.verifyOTP are still there and still work — but
// there is no SMS provider wired, so a code can only reach the server
// log, and a door nobody can walk through is worse than no door. See
// backend auth/password.go for the whole trade, and the OTP_SIGNIN_
// DISABLED flag for how it comes back.
//
// No sign-up either, while the product is being shaped around one
// business: accounts are created for people rather than by them.
export default function SignInScreen({ onSession }) {
  const { t } = useLanguage();
  const { environment } = getFrontendConfig();

  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      onSession(await api.signIn(phone, password));
    } catch (err) {
      setError(err.message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>{t('app_title')}</Text>
          <LanguageSwitcher />
        </View>
        <Text style={styles.subtitle}>{t('app_subtitle')}</Text>
      </View>

      <View style={styles.card}>
        <Banner message={error} />

        <Field
          label={t('phone_number')}
          size="md"
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
          placeholder="98765 43210"
          autoFocus
        />
        <Field
          label={t('password')}
          size="md"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder="••••••"
          onSubmitEditing={phone.trim() && password ? submit : undefined}
        />
        <Button title={t('sign_in')} onPress={submit} busy={busy} disabled={!phone.trim() || !password} />
        <Text style={styles.hint}>{t('signin_password_hint')}</Text>

        {environment !== 'prod' ? <DevLogin onSession={onSession} onError={setError} /> : null}
      </View>
    </ScrollView>
  );
}

// The demo door. Kept deliberately through the move to phone + OTP so a
// demo needs neither a real phone number nor a code — the route only
// exists outside production (see handleDevLogin).
function DevLogin({ onSession, onError }) {
  const [busy, setBusy] = useState(false);
  const { t } = useLanguage();

  const go = async () => {
    setBusy(true);
    try {
      onSession(await api.devLogin());
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.devBox}>
      <Button title={t('continue_as_dev_admin')} variant="secondary" onPress={go} busy={busy} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: spacing.lg, maxWidth: 460, width: '100%', alignSelf: 'center' },
  header: { marginTop: spacing.xl, marginBottom: spacing.lg },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  title: { fontSize: 26, fontWeight: '800', color: colors.text },
  subtitle: { fontSize: 14, color: colors.subtitle, marginTop: spacing.xs },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  lead: { fontSize: 14, color: colors.text, marginBottom: spacing.md, lineHeight: 20 },
  label: { fontSize: 13, fontWeight: '600', color: colors.label, marginBottom: spacing.xs },
  hint: { fontSize: 12, color: colors.hint, marginTop: spacing.sm, lineHeight: 17 },
  linkRow: { minHeight: 44, justifyContent: 'center', alignItems: 'center', marginTop: spacing.xs },
  link: { fontSize: 14, fontWeight: '600', color: colors.link },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipTextActive: { fontSize: 13, fontWeight: '600', color: colors.accentText },
  devBox: { marginTop: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
});
