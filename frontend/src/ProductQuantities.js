import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { EVERY_DAY, PRESETS, WEEKDAYS, describeDays, presetFor } from './frequency';
import { colors, radius, spacing } from './theme';

// How much of each product a customer wants, all in one control.
//
// This used to be a single-select chip row: pick one product, set one
// quantity. That is the wrong shape for the business — a dairy customer
// on 2L of milk every morning who also takes a tub of curd is the
// ordinary case, not an edge case, and the old form made it two separate
// trips through "Add an order" to say so. The data model was never the
// constraint: a RecurringOrder is one row per customer *per product*, so
// several products was always just several rows.
//
// Every product is listed with a quantity, and anything left at zero
// simply isn't ordered. That means the control also answers "what does
// this customer take?" at a glance, which a chip row could not.
// `days` and `onDaysChange` are optional: pass them and each chosen
// product grows its own "how often" picker, leave them out and the
// control is just quantities (which is what a one-off order wants — a
// single delivery has no frequency to ask about).
export default function ProductQuantities({ products, quantities, onChange, unitLabel, days, onDaysChange }) {
  const setQty = (productId, next) => {
    const clamped = Math.max(0, Math.min(99, next));
    const updated = { ...quantities };
    if (clamped === 0) {
      delete updated[productId];
    } else {
      updated[productId] = clamped;
    }
    onChange(updated);
  };

  return (
    <View style={styles.list}>
      {products.map((product) => {
        const qty = quantities[product.id] || 0;
        const on = qty > 0;
        return (
          <View key={product.id} style={[styles.row, on && styles.rowOn]}>
            <View style={styles.topLine}>
            <View style={styles.text}>
              <Text style={[styles.name, on && styles.nameOn]}>{product.name}</Text>
              {product.unit ? <Text style={styles.unit}>{product.unit}</Text> : null}
            </View>
            <View style={styles.stepper}>
              <Pressable
                onPress={() => setQty(product.id, qty - 1)}
                disabled={qty <= 0}
                accessibilityRole="button"
                accessibilityLabel={`One fewer ${product.name}`}
                style={({ pressed }) => [styles.step, qty <= 0 && styles.stepDisabled, pressed && styles.pressed]}
              >
                <Text style={styles.symbol}>−</Text>
              </Pressable>
              <Text style={[styles.value, on && styles.valueOn]}>{qty}</Text>
              <Pressable
                onPress={() => setQty(product.id, qty + 1)}
                accessibilityRole="button"
                accessibilityLabel={`One more ${product.name}`}
                style={({ pressed }) => [styles.step, pressed && styles.pressed]}
              >
                <Text style={styles.symbol}>+</Text>
              </Pressable>
            </View>
            </View>
            {/* Only what they actually take gets asked how often. A
                frequency picker on a product at zero is a question about
                nothing, and seven of them turn this list back into the
                wall of controls it was built to stop being. */}
            {on && days ? <Frequency product={product} days={days} onDaysChange={onDaysChange} /> : null}
          </View>
        );
      })}
      {unitLabel ? <Text style={styles.hint}>{unitLabel}</Text> : null}
    </View>
  );
}

// One product's "how often". The preset is the whole answer for almost
// everybody; the chips only exist because a few customers genuinely do
// have their own arrangement, and hiding them behind the last option
// keeps the common case to a single dropdown.
function Frequency({ product, days, onDaysChange }) {
  const mine = days[product.id] || EVERY_DAY;
  // Whether the chips are showing has to be remembered, not derived.
  // "Chosen days" keeps the days you already had — which is the right
  // behaviour, you are there to adjust them — but that means asking the
  // days what preset they are would answer "every other day" the instant
  // you picked custom, and the dropdown would snap back before you could
  // touch a chip.
  const [custom, setCustom] = useState(() => presetFor(mine) === 'custom');
  const preset = custom ? 'custom' : presetFor(mine);
  const toggle = (day) => {
    const next = mine.includes(day) ? mine.filter((d) => d !== day) : [...mine, day];
    onDaysChange({ ...days, [product.id]: next });
  };
  return (
    <View style={styles.freq}>
      <select
        value={preset}
        style={freqSelectStyle}
        aria-label={`How often ${product.name}`}
        onChange={(event) => {
          const hit = PRESETS.find((p) => p.value === event.target.value);
          setCustom(event.target.value === 'custom');
          onDaysChange({ ...days, [product.id]: hit && hit.days ? hit.days : mine });
        }}
      >
        {PRESETS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </select>
      {preset === 'custom' ? (
        <View style={styles.dayRow}>
          {WEEKDAYS.map((day) => (
            <Pressable
              key={day.value}
              onPress={() => toggle(day.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: mine.includes(day.value) }}
              style={[styles.day, mine.includes(day.value) && styles.dayOn]}
            >
              <Text style={[styles.dayText, mine.includes(day.value) && styles.dayTextOn]}>{day.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : preset === 'daily' ? null : (
        // The preset names the rhythm; this names the days. Without it
        // "every other day" is a promise the admin cannot check. "Every
        // day" needs no such gloss — it would only repeat itself.
        <Text style={styles.freqNote}>{describeDays(mine)}</Text>
      )}
    </View>
  );
}

// The chosen products, as the API wants them: one entry per product with
// a quantity above zero. Kept here so every caller builds the same shape.
export function chosenProducts(quantities) {
  return Object.entries(quantities)
    .filter(([, qty]) => qty > 0)
    .map(([productId, quantity]) => ({ product_id: productId, quantity }));
}

// Sized to its content: a frequency is two or three words, and stretching
// it across the row would make it look like the more important control of
// the two, which it is not.
const freqSelectStyle = {
  width: 'auto',
  alignSelf: 'flex-start',
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: radius.md,
  paddingTop: 4,
  paddingBottom: 4,
  paddingLeft: spacing.sm,
  paddingRight: spacing.sm,
  fontSize: 13,
  color: colors.text,
  backgroundColor: colors.surface,
  fontFamily: 'inherit',
};

const styles = StyleSheet.create({
  list: { marginBottom: spacing.sm },
  topLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  // Indented to the product name it belongs to, so a list of several
  // products reads as name-then-frequency rather than one flat column of
  // unrelated controls.
  freq: { marginTop: 2, marginBottom: 4, paddingLeft: spacing.sm, gap: 4, alignItems: 'flex-start' },
  freqNote: { fontSize: 12, color: colors.hint },
  dayRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  day: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dayOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  dayText: { fontSize: 12, fontWeight: '600', color: colors.subtitle },
  dayTextOn: { color: colors.accentText },
  row: {
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  // Only the chosen ones are outlined, so the row of products reads as a
  // summary of this customer's order rather than a wall of controls.
  rowOn: { borderColor: colors.accent, backgroundColor: colors.surface },
  text: { flexShrink: 1 },
  name: { fontSize: 15, fontWeight: '600', color: colors.label },
  nameOn: { color: colors.text, fontWeight: '700' },
  unit: { fontSize: 12, color: colors.hint, marginTop: 1 },
  stepper: { flexDirection: 'row', alignItems: 'center', flexShrink: 0 },
  step: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepDisabled: { opacity: 0.3 },
  pressed: { opacity: 0.6 },
  symbol: { fontSize: 20, fontWeight: '700', color: colors.link, lineHeight: 24 },
  value: { minWidth: 30, textAlign: 'center', fontSize: 16, fontWeight: '700', color: colors.hint },
  valueOn: { color: colors.text },
  hint: { fontSize: 12, color: colors.hint, marginTop: spacing.xs, lineHeight: 16 },
});
