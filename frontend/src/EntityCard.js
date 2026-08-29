import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from './theme';

// A read-only summary for an entity that showed up as background context
// on someone else's map — a customer glimpsed while managing drivers, a
// driver glimpsed while checking a route, the business's own depot seen
// from either. No edit control here on purpose: editing that entity is a
// different screen's job, and offering it here would blur which screen
// owns what. Instead it says where to go, so tapping a muted pin is
// never a dead end.
export function ReadOnlyEntityCard({ kind, data }) {
  if (!data) {
    return null;
  }
  if (kind === 'customer') {
    return (
      <View style={styles.box}>
        <Text style={styles.name}>{data.name}</Text>
        <Text style={styles.meta}>{[data.address, data.phone].filter(Boolean).join(' · ') || 'No contact details yet'}</Text>
        <Text style={styles.hint}>Edit this customer&apos;s location on the Customers tab.</Text>
      </View>
    );
  }
  if (kind === 'driver') {
    return (
      <View style={styles.box}>
        <Text style={styles.name}>{data.name}</Text>
        <Text style={styles.meta}>{data.phone || 'No phone on file'}</Text>
        <Text style={styles.hint}>Edit where this driver finishes on the Drivers tab.</Text>
      </View>
    );
  }
  if (kind === 'business') {
    return (
      <View style={styles.box}>
        <Text style={styles.name}>Your business</Text>
        <Text style={styles.hint}>Edit this on the Business tab.</Text>
      </View>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  box: {
    marginTop: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
  },
  name: { fontSize: 15, fontWeight: '700', color: colors.text },
  meta: { fontSize: 13, color: colors.subtitle, marginTop: 2 },
  hint: { fontSize: 12, color: colors.hint, marginTop: spacing.xs },
});
