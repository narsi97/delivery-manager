import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { colors, radius, spacing } from './theme';

export function Card({ children, style }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ children, right }) {
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={styles.sectionTitle}>{children}</Text>
      {right ? <View>{right}</View> : null}
    </View>
  );
}

export function Field({ label, hint, ...inputProps }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.hint}
        {...inputProps}
        style={[styles.input, inputProps.multiline ? styles.inputMultiline : null, inputProps.style]}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Button({ title, onPress, variant = 'primary', disabled, busy, style }) {
  const isPlain = variant === 'secondary' || variant === 'danger';
  return (
    <Pressable
      onPress={disabled || busy ? undefined : onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled || !!busy }}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' && styles.buttonPrimary,
        variant === 'secondary' && styles.buttonSecondary,
        variant === 'danger' && styles.buttonDanger,
        (disabled || busy) && styles.buttonDisabled,
        pressed && styles.buttonPressed,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={isPlain ? colors.text : colors.accentText} />
      ) : (
        <Text
          style={[
            styles.buttonText,
            variant === 'secondary' && styles.buttonTextSecondary,
            variant === 'danger' && styles.buttonTextDanger,
          ]}
        >
          {title}
        </Text>
      )}
    </Pressable>
  );
}

// Pill is the status chip used on every stop. Status colour is the fastest
// thing to read on a phone at a doorstep, so delivered/failed/skipped each
// get their own, rather than all sharing a neutral grey.
export function Pill({ label, tone = 'neutral' }) {
  const tones = {
    neutral: { bg: colors.muted, fg: colors.label },
    success: { bg: colors.successBg, fg: colors.success },
    warning: { bg: colors.warningBg, fg: colors.warning },
    error: { bg: colors.errorBg, fg: colors.error },
  };
  const { bg, fg } = tones[tone] || tones.neutral;
  return (
    <View style={[styles.pill, { backgroundColor: bg }]}>
      <Text style={[styles.pillText, { color: fg }]}>{label}</Text>
    </View>
  );
}

export function Banner({ message, tone = 'error' }) {
  if (!message) {
    return null;
  }
  const tones = {
    error: { bg: colors.errorBg, fg: colors.error },
    success: { bg: colors.successBg, fg: colors.success },
    info: { bg: colors.warningBg, fg: colors.warning },
  };
  const { bg, fg } = tones[tone] || tones.error;
  return (
    <View style={[styles.banner, { backgroundColor: bg }]}>
      <Text style={[styles.bannerText, { color: fg }]}>{message}</Text>
    </View>
  );
}

export function Stat({ label, value, tone }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, tone === 'success' && { color: colors.success }, tone === 'error' && { color: colors.error }]}>
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

export function Empty({ children }) {
  return <Text style={styles.empty}>{children}</Text>;
}


// DeclaredFields renders whatever a business declared — custom fields on a
// customer, or captures at the doorstep. Both are the same shape ({key,
// label, type, required, hint}) and both are validated server-side, so one
// renderer serves both and there is no client-side rule that can drift
// from the server's.
//
// values is a plain object keyed by spec.key; onChange receives the whole
// updated object, because the caller stores it as one bag and sends it as
// one bag.
export function DeclaredFields({ specs, values, onChange }) {
  if (!specs || specs.length === 0) {
    return null;
  }

  const set = (key, value) => onChange({ ...values, [key]: value });

  return (
    <View>
      {specs.map((spec) => {
        const label = (spec.label || spec.key) + (spec.required ? ' *' : '');
        const value = values?.[spec.key];

        if (spec.type === 'boolean') {
          return (
            <View key={spec.key} style={styles.switchField}>
              <View style={styles.switchLabel}>
                <Text style={styles.label}>{label}</Text>
                {spec.hint ? <Text style={styles.hint}>{spec.hint}</Text> : null}
              </View>
              <Switch value={!!value} onValueChange={(next) => set(spec.key, next)} />
            </View>
          );
        }

        return (
          <Field
            key={spec.key}
            label={label}
            hint={spec.hint}
            // Numbers are held as the raw string the user typed and
            // coerced server-side (see domain.coerceValue). Parsing on
            // every keystroke would fight the user mid-entry — "1." is not
            // yet a number but is a perfectly normal thing to have typed.
            value={value === undefined || value === null ? '' : String(value)}
            onChangeText={(next) => set(spec.key, next)}
            keyboardType={spec.type === 'number' ? 'numeric' : spec.type === 'phone' ? 'phone-pad' : 'default'}
          />
        );
      })}
    </View>
  );
}

// capturesForStatus filters the declared captures down to the ones that
// apply to the outcome a driver is reporting. Mirrors
// domain.CaptureSpec.AppliesOn — an empty on_status means "any outcome".
export function capturesForStatus(captures, status) {
  return (captures || []).filter(
    (spec) => !spec.on_status || spec.on_status.length === 0 || spec.on_status.includes(status)
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: colors.text },
  field: { marginBottom: spacing.md },
  label: { fontSize: 13, fontWeight: '600', color: colors.label, marginBottom: spacing.xs },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  inputMultiline: { minHeight: 72, textAlignVertical: 'top' },
  hint: { fontSize: 12, color: colors.hint, marginTop: spacing.xs },
  button: {
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 46,
  },
  buttonPrimary: { backgroundColor: colors.accent },
  buttonSecondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  buttonDanger: { backgroundColor: colors.errorBg, borderWidth: 1, borderColor: colors.errorBg },
  buttonDisabled: { opacity: 0.5 },
  buttonPressed: { opacity: 0.8 },
  buttonText: { color: colors.accentText, fontWeight: '700', fontSize: 15 },
  buttonTextSecondary: { color: colors.text },
  buttonTextDanger: { color: colors.error },
  pill: { paddingHorizontal: spacing.sm, paddingVertical: 3, borderRadius: 999, alignSelf: 'flex-start' },
  pillText: { fontSize: 12, fontWeight: '700' },
  banner: { borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.md },
  bannerText: { fontSize: 14, fontWeight: '600' },
  stat: { flex: 1, minWidth: 76, alignItems: 'center', paddingVertical: spacing.sm },
  statValue: { fontSize: 24, fontWeight: '800', color: colors.text },
  statLabel: { fontSize: 12, color: colors.subtitle, marginTop: 2 },
  empty: { color: colors.subtitle, fontSize: 14, paddingVertical: spacing.md },
  switchField: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
    gap: spacing.md,
  },
  switchLabel: { flex: 1 },
});
