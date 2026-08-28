import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { LANGUAGES, useLanguage } from './i18n';
import { colors, radius, spacing } from './theme';

// A small EN/తె pill toggle. Two call sites: SignInScreen's header (a
// driver should be able to switch before they've even signed in) and
// App.js's top bar (switchable anytime after). Same pill visual
// language as SignInScreen's own Tab/switch controls — no new pattern.
export default function LanguageSwitcher() {
  const { lang, setLanguage } = useLanguage();

  return (
    <View style={styles.row}>
      {LANGUAGES.map((option) => (
        <Pressable
          key={option.value}
          onPress={() => setLanguage(option.value)}
          style={[styles.pill, lang === option.value && styles.pillActive]}
          accessibilityRole="button"
          accessibilityLabel={`Switch language to ${option.label}`}
        >
          <Text style={[styles.pillText, lang === option.value && styles.pillTextActive]}>{option.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 4 },
  pill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pillActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  pillText: { fontSize: 12, fontWeight: '700', color: colors.label },
  pillTextActive: { color: colors.accentText },
});
