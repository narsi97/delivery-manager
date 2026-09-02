import React, { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from './theme';

// Taking back a change you have already saved.
//
// Everything on the customer roster saves the moment you press the
// button: the name, the pin, which round somebody is on, the order the
// list is driven in. That is the right behaviour — a half-saved customer
// is worse than none — but it means the browser's own undo is useless.
// Ctrl+Z works inside a text box right up until you save, and then the
// old value is gone and the only way back is remembering what it was.
//
// So an action records how to reverse itself. Nothing here is a
// transaction or a snapshot of the world; each entry is just a pair of
// functions the caller already knows how to write, because the caller is
// the thing that made the change.
//
// Deliberately not a general undo for the whole app. An undo that can
// reach across screens has to answer "what does undo mean now that
// somebody else changed that row?", and the honest answer needs
// versioning the backend does not have. This one is small, local, and
// forgets itself the moment you leave.
const MAX_ENTRIES = 20;

export function useUndoStack({ onError } = {}) {
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const [busy, setBusy] = useState(false);
  // Guards a double-tap on Undo while the first one is still in flight,
  // which would otherwise pop two entries for one intent.
  const running = useRef(false);

  // record is called *after* the change has been saved, with what it
  // takes to put things back and to do it again.
  const record = useCallback((entry) => {
    setPast((prev) => [...prev, entry].slice(-MAX_ENTRIES));
    // A fresh change makes any redo meaningless: you cannot redo your
    // way back to a future that no longer follows from here.
    setFuture([]);
  }, []);

  const step = useCallback(
    async (from, setFrom, to, setTo, direction) => {
      if (running.current || from.length === 0) {
        return;
      }
      const entry = from[from.length - 1];
      running.current = true;
      setBusy(true);
      try {
        await (direction === 'undo' ? entry.undo : entry.redo)();
        setFrom(from.slice(0, -1));
        setTo((prev) => [...prev, entry].slice(-MAX_ENTRIES));
      } catch (err) {
        // The entry stays where it was: a failed undo has not happened,
        // and moving it would leave the two stacks describing a history
        // that never took place.
        if (onError) {
          onError(err.message);
        }
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [onError],
  );

  const undo = useCallback(() => step(past, setPast, future, setFuture, 'undo'), [past, future, step]);
  const redo = useCallback(() => step(future, setFuture, past, setPast, 'redo'), [past, future, step]);

  return {
    record,
    undo,
    redo,
    busy,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    undoLabel: past.length > 0 ? past[past.length - 1].label : '',
    redoLabel: future.length > 0 ? future[future.length - 1].label : '',
  };
}

// The bar itself. Only there once something has actually been changed,
// and it says *what* — "Undo" on its own asks you to remember what you
// last did, which is the thing you are reaching for undo because you
// cannot.
export function UndoBar({ canUndo, canRedo, undoLabel, redoLabel, onUndo, onRedo, busy }) {
  if (!canUndo && !canRedo) {
    return null;
  }
  const label = canUndo ? undoLabel : `${redoLabel} (undone)`;
  return (
    <View style={styles.bar}>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.actions}>
        <Action title="Undo" hint={undoLabel} disabled={!canUndo || busy} onPress={onUndo} />
        <Action title="Redo" hint={redoLabel} disabled={!canRedo || busy} onPress={onRedo} />
      </View>
    </View>
  );
}

function Action({ title, hint, disabled, onPress }) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={hint ? `${title}: ${hint}` : title}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [styles.action, disabled && styles.actionOff, pressed && styles.actionPressed]}
    >
      <Text style={[styles.actionText, disabled && styles.actionTextOff]}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    flexWrap: 'wrap',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
  },
  label: { fontSize: 13, color: colors.subtitle, flexShrink: 1 },
  actions: { flexDirection: 'row', gap: spacing.sm },
  action: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  actionOff: { opacity: 0.4 },
  actionPressed: { opacity: 0.6 },
  actionText: { fontSize: 13, fontWeight: '700', color: colors.link },
  actionTextOff: { color: colors.hint },
});
