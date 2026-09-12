import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import * as api from './api';
import { Button } from './components';
import { colors, radius, spacing } from './theme';

// A day's milk, from where it came to where it has to go.
//
// The herd's milking sheet knows what the animals gave; the round knows
// what it needs, in bottles. Neither knows whether there is enough, because
// milk moves around both — cans bought in from a neighbour, milk kept back
// for the house or given to family, milk from an animal under treatment
// that has to be poured away. This is the one place all of that is added
// up, in litres, and turned into bottles with one press.
//
// It sits with the stock table because that is where the bottling
// decision is made: the numbers somebody would otherwise type into the
// shelf are worked out right above it. The ledger itself is computed on
// the server (see milkledger.go), so this screen and the milking sheet can
// never add a day's milk up two different ways.
export default function MilkLedger({ token, date, stockSignature, onChanged, onError }) {
  const [ledger, setLedger] = useState(null);
  const [entering, setEntering] = useState(null); // 'in' | 'out' | null
  const [litres, setLitres] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      setLedger(await api.getMilkDay(token, date));
    } catch (err) {
      onError(err.message);
    }
  }, [token, date, onError]);

  // Reloaded when the shelf changes as well as the date: a figure typed
  // into the stock table below changes what this ledger calls bottled.
  useEffect(() => {
    load();
  }, [load, stockSignature]);

  if (!ledger) {
    return null;
  }

  const add = async () => {
    const amount = Number(litres);
    if (!Number.isFinite(amount) || amount <= 0) {
      return;
    }
    setBusy('add');
    try {
      await api.addMilkAdjustment(token, { date, litres: amount, direction: entering, note });
      setLitres('');
      setNote('');
      setEntering(null);
      await load();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy('');
    }
  };

  const remove = async (id) => {
    setBusy(id);
    try {
      await api.deleteMilkAdjustment(token, id);
      await load();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy('');
    }
  };

  const bottle = async () => {
    setBusy('bottle');
    try {
      await api.bottleMilk(token, date);
      await onChanged();
      await load();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy('');
    }
  };

  const balance = round(ledger.available - ledger.needed);
  const short = ledger.needed > 0 && balance < 0;
  // Offered only when there is something to fill and milk to fill it
  // with. Short, and the ledger says by how much instead — see
  // handleBottleMilk, which refuses rather than choosing who goes
  // without.
  const canBottle = ledger.needed > 0 && !short && ledger.bottled + 0.001 < ledger.needed;
  const incoming = ledger.adjustments.filter((a) => a.direction === 'in');
  const outgoing = ledger.adjustments.filter((a) => a.direction === 'out');

  return (
    <View style={styles.wrap}>
      <Line label="From the herd" litres={ledger.herd} />
      <Line label="Bought in" litres={ledger.bought_in} sign="+" muted={ledger.bought_in === 0} />
      {incoming.map((a) => (
        <Entry key={a.id} entry={a} busy={busy === a.id} onRemove={() => remove(a.id)} />
      ))}
      <Line label="Kept back" litres={ledger.kept_back} sign="−" muted={ledger.kept_back === 0} />
      {outgoing.map((a) => (
        <Entry key={a.id} entry={a} busy={busy === a.id} onRemove={() => remove(a.id)} />
      ))}
      {/* Stated apart and never inside the herd's figure: produced, and
          poured away. The milking sheet says the same number as
          "discarded". */}
      {ledger.withheld > 0 ? (
        <Text style={styles.withheld}>{litresText(ledger.withheld)} poured away — under treatment</Text>
      ) : null}

      <View style={styles.rule} />
      <Line label="Available" litres={ledger.available} strong />
      <Line label="The round needs" litres={ledger.needed} />
      {ledger.needed > 0 ? (
        short ? (
          <Line label="Short by" litres={-balance} tone="warning" strong />
        ) : (
          <Line label="Left over" litres={balance} />
        )
      ) : null}

      {ledger.unmeasured.length > 0 ? (
        <Text style={styles.unmeasured}>Not in litres: {ledger.unmeasured.join(', ')}</Text>
      ) : null}

      {entering ? (
        <View style={styles.entryForm}>
          <Text style={styles.entryFormTitle}>{entering === 'in' ? 'Bought in' : 'Kept back'}</Text>
          <View style={styles.entryFields}>
            <input
              value={litres}
              inputMode="decimal"
              autoFocus
              placeholder="Litres"
              aria-label={entering === 'in' ? 'Litres bought in' : 'Litres kept back'}
              onChange={(event) => setLitres(event.target.value.replace(/[^0-9.]/g, ''))}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  add();
                }
              }}
              style={{ ...inputStyle, width: 80 }}
            />
            <input
              value={note}
              placeholder={entering === 'in' ? 'From whom' : 'Home, family, calves…'}
              aria-label="What it was for"
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  add();
                }
              }}
              style={{ ...inputStyle, flex: 1, minWidth: 120 }}
            />
          </View>
          <View style={styles.entryButtons}>
            <Button title="Add" onPress={add} busy={busy === 'add'} disabled={!(Number(litres) > 0)} />
            <Button title="Cancel" variant="secondary" onPress={() => setEntering(null)} />
          </View>
        </View>
      ) : (
        <View style={styles.actions}>
          <Chip label="+ Bought in" onPress={() => setEntering('in')} />
          <Chip label="− Kept back" onPress={() => setEntering('out')} />
          {canBottle ? (
            <Pressable
              onPress={bottle}
              disabled={busy === 'bottle'}
              accessibilityRole="button"
              accessibilityLabel="Fill the shelf for this round from this milk"
              style={({ pressed }) => [styles.bottle, pressed && styles.pressed]}
            >
              <Text style={styles.bottleText}>{busy === 'bottle' ? 'Bottling…' : 'Bottle for the round'}</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}

function Line({ label, litres, sign, muted, strong, tone }) {
  return (
    <View style={styles.line}>
      <Text style={[styles.lineLabel, muted && styles.muted, strong && styles.strong, tone === 'warning' && styles.warn]}>
        {label}
      </Text>
      <Text
        style={[styles.lineFigure, muted && styles.muted, strong && styles.strong, tone === 'warning' && styles.warn]}
      >
        {sign && litres > 0 ? `${sign} ` : ''}
        {litresText(litres)}
      </Text>
    </View>
  );
}

// One line somebody typed. The note is what makes it theirs — "Ramesh",
// "sister's family" — and the ✕ is for the typo made a minute ago.
function Entry({ entry, busy, onRemove }) {
  return (
    <View style={styles.entry}>
      <Text style={styles.entryNote} numberOfLines={1}>
        {entry.note || (entry.direction === 'in' ? 'bought in' : 'kept back')}
      </Text>
      <Text style={styles.entryFigure}>{litresText(entry.litres)}</Text>
      <Pressable
        onPress={onRemove}
        disabled={busy}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${litresText(entry.litres)} ${entry.note || ''}`.trim()}
        style={({ pressed }) => [styles.entryRemove, pressed && styles.pressed]}
      >
        <Text style={styles.entryRemoveGlyph}>✕</Text>
      </Pressable>
    </View>
  );
}

function Chip({ label, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
    >
      <Text style={styles.chipText}>{label}</Text>
    </Pressable>
  );
}

function round(v) {
  return Math.round((Number(v) || 0) * 1000) / 1000;
}

// Two places, because packets come in quarter litres: 17 × 500 ml and
// 5 × 750 ml is 44.25 L, and one place said 44.3 — a number no pile of
// packets adds up to. Trailing zeros go, so 44.5 is not "44.50".
function litresText(v) {
  const n = round(v);
  return `${Number(n.toFixed(2))} L`;
}

const inputStyle = {
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: colors.border,
  borderRadius: radius.md,
  paddingTop: spacing.sm,
  paddingBottom: spacing.sm,
  paddingLeft: spacing.sm,
  paddingRight: spacing.sm,
  fontSize: 15,
  color: colors.text,
  backgroundColor: colors.surface,
  fontFamily: 'inherit',
  outline: 'none',
};

const styles = StyleSheet.create({
  wrap: {
    marginBottom: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  line: { flexDirection: 'row', alignItems: 'baseline', paddingVertical: 3 },
  lineLabel: { flex: 1, fontSize: 14, color: colors.label },
  lineFigure: { fontSize: 14, color: colors.label, fontVariant: ['tabular-nums'], minWidth: 72, textAlign: 'right' },
  muted: { color: colors.hint },
  strong: { fontWeight: '800', color: colors.text },
  warn: { color: colors.warning },
  rule: { borderTopWidth: 1, borderTopColor: colors.border, marginVertical: spacing.xs },
  withheld: { fontSize: 12, color: colors.warning, marginTop: 2 },
  unmeasured: { fontSize: 12, color: colors.subtitle, marginTop: spacing.xs },

  entry: { flexDirection: 'row', alignItems: 'center', paddingLeft: spacing.md },
  entryNote: { flex: 1, fontSize: 12, color: colors.subtitle },
  entryFigure: { fontSize: 12, color: colors.subtitle, fontVariant: ['tabular-nums'] },
  entryRemove: { paddingHorizontal: spacing.sm, paddingVertical: 2 },
  entryRemoveGlyph: { fontSize: 12, fontWeight: '700', color: colors.hint },

  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  chip: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipText: { fontSize: 13, fontWeight: '600', color: colors.link },
  bottle: {
    marginLeft: 'auto',
    paddingVertical: 7,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
  },
  bottleText: { fontSize: 13, fontWeight: '700', color: colors.accentText },
  pressed: { opacity: 0.7 },

  entryForm: { marginTop: spacing.sm },
  entryFormTitle: { fontSize: 13, fontWeight: '700', color: colors.text, marginBottom: spacing.xs },
  entryFields: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  entryButtons: { flexDirection: 'row', gap: spacing.sm },
});
