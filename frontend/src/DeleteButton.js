import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Banner, Button } from './components';
import { colors, radius, spacing } from './theme';

// Deleting one thing, once somebody has said they are tidying up.
//
// Absent unless the window is open — see deleteMode.js and the server,
// which is what actually refuses. A button that fails is worse than a
// button that is not there.
//
// The confirmation states what will go, in numbers the server counted,
// and makes you press a second time. Not because a second press is
// security — it is not — but because the first press is often a thumb
// on a phone, and the sentence between the two presses is the only
// chance anybody gets to read what they are about to lose.
//
// `compact` is the same thing sized for a table row: a single ✕ where a
// full-width red button would be a third column. The confirmation is
// unchanged — it still says what will go and still wants a second
// press, because that sentence is the point of the control.
export default function DeleteButton({ armed, label, describe, compact, onDelete, onDone, onError }) {
  const [asking, setAsking] = useState(false);
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!armed) {
    return null;
  }

  const ask = async () => {
    setError('');
    setAsking(true);
    if (!describe) {
      return;
    }
    // Counted now rather than when the row rendered, so the sentence is
    // true at the moment it is read.
    try {
      setDetail(await describe());
    } catch (err) {
      setDetail('');
      setError(err.message);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      await onDelete();
      setAsking(false);
      if (onDone) {
        await onDone();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!asking) {
    if (compact) {
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label || 'Delete'}
          onPress={ask}
          style={({ hovered }) => [styles.icon, hovered && styles.iconHover]}
        >
          <Text style={styles.iconGlyph}>✕</Text>
        </Pressable>
      );
    }
    return (
      <View style={styles.wrap}>
        <Banner message={error} />
        <Button title={label || 'Delete'} variant="danger" onPress={ask} style={styles.button} />
      </View>
    );
  }

  return (
    <View style={styles.confirm}>
      <Banner message={error} />
      <Text style={styles.what}>{detail || 'This cannot be undone.'}</Text>
      <View style={styles.row}>
        <Button title="Yes, delete" variant="danger" onPress={confirm} busy={busy} style={styles.flexButton} />
        <Button title="Keep it" variant="secondary" onPress={() => setAsking(false)} style={styles.flexButton} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.sm },
  // Sized to the number cells beside it so the row keeps its baseline.
  icon: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  iconHover: { backgroundColor: colors.errorBg },
  iconGlyph: { fontSize: 13, lineHeight: 16, color: colors.error, fontWeight: '700' },
  button: { alignSelf: 'flex-start' },
  confirm: {
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.error,
    backgroundColor: colors.errorBg,
  },
  what: { fontSize: 13, color: colors.error, lineHeight: 18, marginBottom: spacing.sm, fontWeight: '600' },
  row: { flexDirection: 'row', gap: spacing.sm },
  flexButton: { flex: 1 },
});
