import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from './theme';

// Who gets visited first.
//
// The labels say what the tier is *for* rather than what it is called,
// because "business" and "early" mean nothing on their own and everything
// once you know a shop opens at six and a school run leaves at half
// seven. An admin picking these is thinking about their customers, not
// about a routing algorithm.
//
// Three, and no more. A fourth invites a scale nobody else understands,
// and the honest way to say "before 07:30" is a time window the routing
// cannot yet promise — see Docs/COMPROMISES.md.
export const PRIORITY_TIERS = [
  { value: 'business', label: 'Shop or business', hint: 'Opens early and cannot take it late' },
  { value: 'early', label: 'Needs it early', hint: 'Children leaving for school, work shifts' },
  { value: 'normal', label: 'Any time', hint: 'The usual' },
];

// Where a tier sorts: 0 first. Mirrors domain.PriorityTier.Rank exactly
// — the roster shows the order the backend will actually drive, so the
// two have to agree about which tier wins.
export function priorityRank(value) {
  const index = PRIORITY_TIERS.findIndex((tier) => tier.value === (value || 'normal'));
  return index === -1 ? PRIORITY_TIERS.length - 1 : index;
}

export default function PriorityPicker({ value, onChange, label = 'Priority', style }) {
  const current = value || 'normal';
  const chosen = PRIORITY_TIERS.find((tier) => tier.value === current) || PRIORITY_TIERS[2];

  return (
    <View style={[styles.wrap, style]}>
      <Text style={styles.label}>{label}</Text>
      {/* A dropdown, not three chips. The chips were a row of buttons
          the width of the card for a field almost every customer leaves
          alone, and they read as three things to decide rather than one
          value with a sensible default. */}
      <select value={current} style={selectStyle} onChange={(event) => onChange(event.target.value)}>
        {PRIORITY_TIERS.map((tier) => (
          <option key={tier.value} value={tier.value}>
            {tier.label}
          </option>
        ))}
      </select>
      {/* Only the chosen tier explains itself. Three hints at once is a
          paragraph nobody reads; one is a sentence that answers "did I
          pick the right thing?". */}
      <Text style={styles.hint}>{chosen.hint}</Text>
    </View>
  );
}

// Fills whatever it is given rather than sizing to its content. A raw
// <select> inside a React Native View is stretched by the column's
// align-items anyway, so "width: auto" only ever looked like a choice;
// the width now comes from the caller, which is the thing that knows
// whether this picker is alone or sharing a line.
const selectStyle = {
  width: '100%',
  minWidth: 0,
  maxWidth: '100%',
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: radius.md,
  paddingTop: spacing.sm,
  paddingBottom: spacing.sm,
  paddingLeft: spacing.md,
  paddingRight: spacing.md,
  fontSize: 14,
  color: colors.text,
  backgroundColor: colors.surface,
  fontFamily: 'inherit',
};

// A small badge for a customer who is not "any time", so the roster shows
// at a glance who is being bumped up the round. Renders nothing for the
// default, because a badge on everybody is a badge on nobody.
export function PriorityBadge({ value }) {
  if (!value || value === 'normal') {
    return null;
  }
  const tier = PRIORITY_TIERS.find((t) => t.value === value);
  if (!tier) {
    return null;
  }
  return (
    <View style={[styles.badge, value === 'business' ? styles.badgeBusiness : styles.badgeEarly]}>
      <Text style={[styles.badgeText, value === 'business' ? styles.badgeTextBusiness : styles.badgeTextEarly]}>
        {value === 'business' ? 'shop' : 'early'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.sm + 2 },
  label: { fontSize: 13, fontWeight: '600', color: colors.label, marginBottom: 3 },
  hint: { fontSize: 12, color: colors.hint, marginTop: 3, lineHeight: 16 },
  badge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: 999, alignSelf: 'flex-start' },
  badgeBusiness: { backgroundColor: colors.accentSoft || colors.surfaceAlt },
  badgeEarly: { backgroundColor: colors.surfaceAlt },
  badgeText: { fontSize: 11, fontWeight: '700' },
  badgeTextBusiness: { color: colors.accent },
  badgeTextEarly: { color: colors.subtitle },
});
