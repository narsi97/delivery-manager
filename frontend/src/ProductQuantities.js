import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

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
export default function ProductQuantities({ products, quantities, onChange, unitLabel }) {
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
        );
      })}
      {unitLabel ? <Text style={styles.hint}>{unitLabel}</Text> : null}
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

const styles = StyleSheet.create({
  list: { marginBottom: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
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
