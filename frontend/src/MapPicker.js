import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from './theme';

// Real implementation is MapPicker.web.js — Leaflet only makes sense in a
// DOM. This product has no native build yet (see deploy/README.md); when
// one exists, this is the seam to swap in react-native-maps without
// touching any caller. Until then, typed coordinates and "pin my current
// location" remain fully working everywhere — this is a convenience on
// top, not the only way in.
export default function MapPicker() {
  return (
    <View style={styles.fallback}>
      <Text style={styles.text}>
        An interactive map isn&apos;t available on this device yet — use the coordinate fields below, or
        &quot;Pin my current location&quot;.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fallback: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  text: { fontSize: 12, color: colors.hint, lineHeight: 17 },
});
