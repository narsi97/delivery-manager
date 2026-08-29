// Native placeholder, mirroring MapPicker.js and RouteMap.js: the
// Leaflet map is web-only, and the admin console this map belongs to is
// a web surface. A native build resolves to this file rather than
// failing to bundle leaflet.
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from './theme';

export default function EntityMap() {
  return (
    <View style={styles.box}>
      <Text style={styles.text}>This map is available in the web admin console.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.sm,
  },
  text: { fontSize: 13, color: colors.subtitle },
});
