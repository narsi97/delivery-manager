import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import * as api from './api';
import { InlineLocationEditor } from './LocationPicker';
import { colors, spacing } from './theme';

// What tapping a customer or driver on the business's own map opens. This
// is the one map in the app where every kind of pin is manageable, so
// unlike the muted, read-only markers everywhere else, this one edits the
// actual record — same InlineLocationEditor the route map uses for a
// stop's pin, wired to whichever entity was tapped.
export default function SelectedEntityEditor({ token, selected, home, onClose, onChanged, onError }) {
  const { kind, data } = selected;

  const save = async (lat, lng) => {
    try {
      if (kind === 'customer') {
        await api.updateCustomer(token, data.id, { lat, lng });
      } else {
        await api.setDriverHome(token, data.id, lat, lng);
      }
      await onChanged();
    } catch (err) {
      onError(err.message);
    }
  };

  return (
    <View style={styles.cardSection}>
      <View style={styles.editHeader}>
        <Text style={styles.readLabel}>{kind === 'customer' ? data.name : `${data.name} finishes at`}</Text>
        <Pressable onPress={onClose} accessibilityRole="button">
          <Text style={styles.doneLink}>Done</Text>
        </Pressable>
      </View>
      {kind === 'customer' ? (
        <Text style={styles.note}>{[data.address, data.phone].filter(Boolean).join(' · ') || 'No contact details yet'}</Text>
      ) : (
        <Text style={styles.note}>{data.phone || 'No phone on file'}</Text>
      )}
      <InlineLocationEditor
        lat={kind === 'customer' ? data.lat : data.home_lat}
        lng={kind === 'customer' ? data.lng : data.home_lng}
        onSave={save}
        home={home}
      />
    </View>
  );
}

// The styles this carried while it lived inside BusinessScreen, brought
// with it so the editor looks the same from either screen.
const styles = StyleSheet.create({
  cardSection: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.xs },
  editHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  readLabel: { fontSize: 12, fontWeight: '600', color: colors.hint, textTransform: 'uppercase', letterSpacing: 0.04 },
  doneLink: { fontSize: 14, fontWeight: '700', color: colors.link },
  note: { fontSize: 12, color: colors.hint, marginBottom: spacing.sm, lineHeight: 17 },
});
