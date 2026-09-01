import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from './theme';

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

export default function PriorityPicker({ value, onChange, label = 'When do they need it?' }) {
  const current = value || 'normal';
  const chosen = PRIORITY_TIERS.find((tier) => tier.value === current) || PRIORITY_TIERS[2];

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.row}>
        {PRIORITY_TIERS.map((tier) => {
          const on = tier.value === current;
          return (
            <Pressable
              key={tier.value}
              onPress={() => onChange(tier.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={tier.label}
              style={[styles.chip, on && styles.chipOn]}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{tier.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {/* Only the chosen tier explains itself. Three hints at once is a
          paragraph nobody reads; one is a sentence that answers "did I
          pick the right thing?". */}
      <Text style={styles.hint}>{chosen.hint}</Text>
    </View>
  );
}

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
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    minHeight: 40,
    justifyContent: 'center',
  },
  chipOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { fontSize: 13, fontWeight: '600', color: colors.label },
  chipTextOn: { color: colors.accentText },
  hint: { fontSize: 12, color: colors.hint, marginTop: 3, lineHeight: 16 },
  badge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: 999, alignSelf: 'flex-start' },
  badgeBusiness: { backgroundColor: colors.accentSoft || colors.surfaceAlt },
  badgeEarly: { backgroundColor: colors.surfaceAlt },
  badgeText: { fontSize: 11, fontWeight: '700' },
  badgeTextBusiness: { color: colors.accent },
  badgeTextEarly: { color: colors.subtitle },
});
