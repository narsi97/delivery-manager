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

// The one way anything in this app opens and closes. Before this there
// were five different expand affordances — a 13px grey chevron on
// customer groups, "+ Add" link text on the creation forms, "Show
// deliveries (N)" on a route, and two headers that were pressable with
// no visual cue at all. Same thing, five looks, none of them big enough
// to hit confidently on a phone.
//
// One shape now: the whole row is the target (44px minimum, the standard
// touch size), the title is on the left, anything the caller wants to
// show while collapsed sits in `right`, and a chevron on the far right
// says which way it goes. `compact` is for a disclosure nested inside
// something that already has its own heading — a route's stop list — so
// it reads as subordinate to the card's title rather than competing.
export function Disclosure({ children, open, onToggle, right, compact }) {
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded: !!open }}
      style={({ pressed }) => [styles.disclosure, pressed && styles.disclosurePressed]}
    >
      <Text style={[styles.disclosureTitle, compact && styles.disclosureTitleCompact]}>{children}</Text>
      {right ? <View style={styles.disclosureRight}>{right}</View> : null}
      <Text style={[styles.disclosureChevron, compact && styles.disclosureChevronCompact]}>{open ? '▾' : '▸'}</Text>
    </Pressable>
  );
}

// A field is as wide as what goes in it. Stretching every input to the
// full card width is the single thing that made this app's forms look
// like a database admin panel: a quantity of "2" got the same 640px as a
// street address. `size` caps the width by what the value actually is —
// the caps are deliberately generous (they're maximums, not fixed
// widths) so a long product name or a two-line address still fits, and
// everything still collapses to full width on a narrow phone.
//
// Default is 'full' so multiline notes and addresses keep the whole row;
// everything shorter should say so.
const FIELD_WIDTHS = {
  xs: 90, // a number: quantity, price, radius, a PIN
  sm: 170, // a phone number, a unit, a coordinate
  md: 300, // a person's name, a search box
  full: undefined,
};

export function Field({ label, hint, size = 'full', ...inputProps }) {
  const maxWidth = FIELD_WIDTHS[size];
  return (
    <View style={[styles.field, maxWidth ? { maxWidth, width: '100%' } : null]}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.hint}
        {...inputProps}
        style={[styles.input, inputProps.multiline ? styles.inputMultiline : null, inputProps.style]}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

// A quantity is picked, not typed. "How many today?" on a milk round is
// almost always one tap away from what it already is, and a text box
// asks the least technical user in this app — an admin on a phone,
// mid-morning — to select, delete, and retype a digit to say "one more".
// Two big targets and a number between them say the same thing with no
// keyboard at all.
//
// Still a real number underneath: `min` guards the bottom (0 means
// "nothing today", which is what Skip records), and the caller owns the
// value so this stays a controlled input like Field.
// A small two-or-three-way view switch, for when one set of records is
// worth seeing more than one way — a roster as a list or on a map, say.
// Deliberately not a Disclosure: those reveal *more* of the same view,
// while this swaps which view you are in, and the segmented shape says
// "these are alternatives, and you are in one of them" without needing a
// label to explain it.
export function ViewToggle({ value, onChange, options }) {
  return (
    <View style={styles.toggle}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={option.label}
            style={[styles.toggleItem, on && styles.toggleItemOn]}
          >
            <Text style={[styles.toggleText, on && styles.toggleTextOn]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Stepper({ label, value, onChange, min = 0, max = 99, hint }) {
  const step = (delta) => onChange(Math.min(max, Math.max(min, value + delta)));
  return (
    <View style={styles.field}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <View style={styles.stepper}>
        <Pressable
          onPress={() => step(-1)}
          disabled={value <= min}
          accessibilityRole="button"
          accessibilityLabel="One fewer"
          style={({ pressed }) => [styles.stepperButton, value <= min && styles.stepperButtonDisabled, pressed && styles.stepperPressed]}
        >
          <Text style={styles.stepperSymbol}>−</Text>
        </Pressable>
        <Text style={styles.stepperValue}>{value}</Text>
        <Pressable
          onPress={() => step(1)}
          disabled={value >= max}
          accessibilityRole="button"
          accessibilityLabel="One more"
          style={({ pressed }) => [styles.stepperButton, value >= max && styles.stepperButtonDisabled, pressed && styles.stepperPressed]}
        >
          <Text style={styles.stepperSymbol}>+</Text>
        </Pressable>
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

// Lays fields side by side instead of stacking them one per row — two
// short inputs (lat/lng, unit/price) belong on one line, and wrapping
// means the same markup still stacks on a phone.
export function FieldRow({ children }) {
  return <View style={styles.fieldRow}>{children}</View>;
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
    marginBottom: spacing.sm + 2,
  },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: colors.text },
  // minHeight stays 44 — this is the tap target for expanding a section,
  // and shrinking it to save space would trade real usability for looks.
  disclosure: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    marginBottom: spacing.xs,
  },
  disclosurePressed: { opacity: 0.6 },
  toggle: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    padding: 2,
  },
  toggleItem: { paddingVertical: 5, paddingHorizontal: 12, borderRadius: radius.sm, minHeight: 32, justifyContent: 'center' },
  toggleItemOn: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  toggleText: { fontSize: 13, fontWeight: '600', color: colors.subtitle },
  toggleTextOn: { color: colors.text },
  stepper: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
  stepperButton: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperButtonDisabled: { opacity: 0.35 },
  stepperPressed: { opacity: 0.6 },
  stepperSymbol: { fontSize: 22, fontWeight: '700', color: colors.link, lineHeight: 26 },
  stepperValue: { minWidth: 52, textAlign: 'center', fontSize: 18, fontWeight: '700', color: colors.text },
  disclosureTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: colors.text },
  disclosureTitleCompact: { fontSize: 15, color: colors.link },
  disclosureRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  disclosureChevron: { fontSize: 20, fontWeight: '700', color: colors.link, width: 20, textAlign: 'center' },
  disclosureChevronCompact: { fontSize: 16, width: 16 },
  // Form rhythm. A label, its input and the gap to the next label repeat
  // for every field on the screen, so a few pixels each compounds fast: a
  // six-field form was running most of a phone screen tall for six short
  // answers, which reads as a long form rather than a quick one.
  //
  // The input keeps fontSize 16 deliberately. Mobile Safari zooms the
  // whole page when a focused input is smaller than that, and a form that
  // jumps and re-scales on every tap is far worse than one a few pixels
  // taller.
  field: { marginBottom: spacing.sm + 2 },
  fieldRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm + 2, alignItems: 'flex-end' },
  label: { fontSize: 13, fontWeight: '600', color: colors.label, marginBottom: 3 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  inputMultiline: { minHeight: 64, textAlignVertical: 'top' },
  hint: { fontSize: 12, color: colors.hint, marginTop: 3, lineHeight: 16 },
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
