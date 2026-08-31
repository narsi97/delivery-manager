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
// employer had issued them. Both are gone: everyone now types a phone
// number and the code sent to it, so the app no longer needs to ask who
// you are before it can let you in. It finds out from the number.
//
// What's left is two steps. Type a number; type the code. The only extra
// is for a number the server doesn't recognise, which needs a business
// name before there is anything to create.
export default function SignInScreen({ onSession }) {
  const { t } = useLanguage();
  const { environment } = getFrontendConfig();

  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  // 'phone' -> asking for the number. 'code' -> a code is out.
  // 'signup' -> the number is new, so we need a business too.
  const [step, setStep] = useState('phone');
  const [businessName, setBusinessName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const sendCode = async (extra = {}) => {
    setBusy(true);
    setError('');
    try {
      await api.requestOTP({ phone, ...extra });
      setNotice(t('code_sent'));
      setStep('code');
    } catch (err) {
      // The server telling us it doesn't know this number isn't an
      // error to show — it's the answer to "are you new?", so the form
      // grows the fields a signup needs instead.
      if (err.code === 'no_account') {
        setStep('signup');
        setError('');
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError('');
    try {
      const session = await api.verifyOTP(phone, code);
      onSession(session);
    } catch (err) {
      setError(err.message);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const startOver = () => {
    setStep('phone');
    setCode('');
    setError('');
    setNotice('');
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
        {step === 'code' ? <Banner message={notice} tone="success" /> : null}

        {step === 'code' ? (
          <View>
            <Text style={styles.lead}>{t('code_sent_to', { phone })}</Text>
            <Field
              label={t('the_code')}
              size="sm"
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              maxLength={6}
              placeholder="6 digits"
              autoFocus
            />
            <Button title={t('sign_in')} onPress={verify} busy={busy} disabled={code.length !== 6} />
            <Pressable onPress={startOver} accessibilityRole="button" style={styles.linkRow}>
              <Text style={styles.link}>{t('use_a_different_number')}</Text>
            </Pressable>
          </View>
        ) : step === 'signup' ? (
          <View>
            <Text style={styles.lead}>{t('no_account_yet')}</Text>
            <Field
              label={t('business_name')}
              size="md"
              value={businessName}
              onChangeText={setBusinessName}
              placeholder="Nalgonda Dairy"
              autoFocus
            />
            <Field label={t('your_name')} size="md" value={ownerName} onChangeText={setOwnerName} placeholder="Narsi" />

            {/* Dairy is the only vertical open to self-signup for now.
                The engine runs schools, water and grocery too (see
                domain.PresetFor), so this is a list with one entry
                rather than a hardcoded value — adding the others is a
                line each, not a redesign. */}
            <Text style={styles.label}>{t('kind_of_business')}</Text>
            <View style={styles.chipRow}>
              <View style={[styles.chip, styles.chipActive]}>
                <Text style={styles.chipTextActive}>{t('business_type_dairy')}</Text>
              </View>
            </View>

            <Button
              title={t('send_me_a_code')}
              onPress={() => sendCode({ businessName, ownerName, businessType: 'dairy' })}
              busy={busy}
              disabled={!businessName.trim()}
            />
            <Pressable onPress={startOver} accessibilityRole="button" style={styles.linkRow}>
              <Text style={styles.link}>{t('use_a_different_number')}</Text>
            </Pressable>
          </View>
        ) : (
          <View>
            <Field
              label={t('phone_number')}
              size="md"
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              placeholder="98765 43210"
              autoFocus
            />
            <Button title={t('send_me_a_code')} onPress={() => sendCode()} busy={busy} disabled={!phone.trim()} />
            <Text style={styles.hint}>{t('signin_hint')}</Text>
          </View>
        )}

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
