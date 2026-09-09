import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from './theme';

// What the two herd screens both need.
//
// The livestock book is two screens because it is read at two rhythms:
// MilkingScreen is opened twice a day and is about one date, HerdScreen
// is opened when something changes and is about no date at all. They
// share their vocabulary and their small formatters, and nothing else.

export const SPECIES = ['buffalo', 'cow'];
export const SEXES = ['female', 'male'];
export const RESULTS = ['pending', 'pregnant', 'empty', 'aborted', 'calved'];

export const HEALTH_KINDS = ['vaccination', 'deworming', 'treatment', 'checkup'];

// The jabs an Indian dairy actually gives, offered as a list so the
// common ones are two taps rather than spelling. FMD comes round every
// six months, HS and BQ annually, brucellosis once in a female calf's
// life — the backend fills the next-due date from the same names, so
// picking one here schedules the next one. Anything not on this list can
// still be typed; it just schedules nothing.
export const COMMON_VACCINES = ['FMD', 'HS', 'BQ', 'HS-BQ', 'Brucellosis', 'Theileria', 'Anthrax'];

// Withdrawal periods worth knowing at the point of typing a treatment.
// Milk from a treated animal must not reach the churn, and the number of
// days depends on the drug — three for oxytetracycline or amoxicillin,
// six for ciprofloxacin, three to four for most intramammary tubes.
// These are defaults to save arithmetic, not veterinary advice: the
// label on the bottle wins, which is why the date stays editable.
export const WITHDRAWAL_DAYS = [
  { label: 'no withdrawal', days: 0 },
  { label: '3 days (oxytetracycline, amoxicillin)', days: 3 },
  { label: '4 days (intramammary tube)', days: 4 },
  { label: '6 days (ciprofloxacin)', days: 6 },
  { label: '7 days', days: 7 },
];

export function addDays(iso, days) {
  const at = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(at.getTime()) || !days) {
    return '';
  }
  at.setDate(at.getDate() + days);
  return at.toISOString().slice(0, 10);
}

// Half the stages are facts about a female animal: a bull is never
// milking, dry or a heifer, and a cow is never a bull. Offering the
// whole list to both is how a male buffalo ends up marked "milking" and
// carrying a lactation record into the day's totals. Mirrors
// domain.StagesFor, which refuses the same combinations server-side.
const FEMALE_STAGES = ['calf', 'heifer', 'milking', 'dry', 'sold', 'died'];
const MALE_STAGES = ['calf', 'bull', 'sold', 'died'];

export function stagesFor(sex) {
  return sex === 'male' ? MALE_STAGES : FEMALE_STAGES;
}

export function defaultStageFor(sex) {
  return sex === 'male' ? 'calf' : 'milking';
}

// Changing an animal's sex has to take its stage with it, or the form
// posts a combination the server will refuse. Keeps the stage when it
// still makes sense — a calf stays a calf either way.
export function stageForSex(stage, sex) {
  return stagesFor(sex).includes(stage) ? stage : defaultStageFor(sex);
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

// Litres read as "10" and "7.5", never "10.0" or "7.50" — a column of
// trailing zeros is ink spent on nothing (Docs/DESIGN.md, rule 2).
export function round1(value) {
  const n = Number(value) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function shortDate(iso) {
  const at = new Date(`${iso}T00:00:00`);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// Whether a date falls within so many days of another. Used for "due
// soon", which is the only form a due date is worth showing in a table:
// a date four months out is not something anybody acts on today.
export function withinDays(iso, from, days) {
  if (!iso) {
    return false;
  }
  const when = new Date(`${iso}T00:00:00`).getTime();
  const start = new Date(`${from || today()}T00:00:00`).getTime();
  if (Number.isNaN(when) || Number.isNaN(start)) {
    return false;
  }
  return when >= start && when - start <= days * 24 * 60 * 60 * 1000;
}

// The one crossing per animal that is still expecting something, keyed
// by animal id — what the backend's herd/day already works out, kept
// here so both screens read it the same way.
export function dueSoonCount(due, date, days = 30) {
  return Object.entries(due || {}).filter(([, when]) => withinDays(when, date, days)).length;
}

export function Picker({ label, value, options, onChange }) {
  return (
    <View style={styles.picker}>
      <Text style={styles.pickerLabel}>{label}</Text>
      <select value={value} aria-label={label} style={pickerStyle} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </View>
  );
}

// Searching a herd by tag. A forty-head farm scrolls; a hundred-head
// farm does not, and the tag is what somebody has in their hand.
export function SearchBox({ value, onChange, placeholder, label }) {
  return (
    <View style={styles.searchBox}>
      <Text style={styles.searchGlyph}>⌕</Text>
      <input
        value={value}
        aria-label={label}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        style={searchInputStyle}
      />
      {value ? (
        <Pressable
          onPress={() => onChange('')}
          accessibilityRole="button"
          accessibilityLabel="Clear the search"
          style={({ pressed }) => [styles.searchClear, pressed && { opacity: 0.6 }]}
        >
          <Text style={styles.searchClearGlyph}>✕</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export const searchInputStyle = {
  flex: 1,
  minWidth: 0,
  border: 'none',
  outline: 'none',
  background: 'transparent',
  paddingTop: spacing.sm,
  paddingBottom: spacing.sm,
  fontSize: 15,
  color: colors.text,
  fontFamily: 'inherit',
};

export const pickerStyle = {
  width: '100%',
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: radius.md,
  paddingTop: spacing.sm,
  paddingBottom: spacing.sm,
  paddingLeft: spacing.sm,
  paddingRight: spacing.sm,
  fontSize: 14,
  color: colors.text,
  backgroundColor: colors.surface,
  fontFamily: 'inherit',
};

export const resultStyle = {
  ...pickerStyle,
  width: 'auto',
  minWidth: 96,
  paddingTop: 4,
  paddingBottom: 4,
  fontSize: 13,
};

const styles = StyleSheet.create({
  picker: { flexGrow: 1, flexBasis: 120, minWidth: 0 },
  pickerLabel: { fontSize: 13, fontWeight: '600', color: colors.label, marginBottom: spacing.xs },
  searchBox: {
    flexGrow: 1,
    flexBasis: 220,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.sm,
  },
  searchGlyph: { fontSize: 18, color: colors.hint, marginRight: 2 },
  searchClear: { paddingHorizontal: spacing.xs, paddingVertical: 2 },
  searchClearGlyph: { fontSize: 13, fontWeight: '700', color: colors.subtitle },
});
