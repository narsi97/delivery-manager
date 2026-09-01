import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import * as api from './api';
import { Banner, Button, Card, Disclosure, Empty, Field, Pill, Stepper } from './components';
import { openNavigation } from './navigation';
import { colors, radius, spacing } from './theme';

// How a single delivery is drawn, wherever it appears — inside a route,
// or in the "not going out yet" card. Kept in one place so a stop looks
// and behaves the same everywhere it turns up.

// A raw DOM element, not an RN primitive — StyleSheet.create's output is
// meant for View/Text/etc. and doesn't apply to <select> the same way, so
// this is a plain CSS-in-JS object matching Field's input styling instead.
export const selectStyle = {
  width: '100%',
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: radius.md,
  paddingTop: spacing.sm,
  paddingBottom: spacing.sm,
  paddingLeft: spacing.md,
  paddingRight: spacing.md,
  fontSize: 15,
  color: colors.text,
  backgroundColor: colors.surface,
  fontFamily: 'inherit',
};

// Same as selectStyle but sized to its content instead of stretched full
// width — this one shares a row with the rebuild icon-button, and a
// driver's name is a handful of characters, not a paragraph. Bounded
// rather than pure auto-width so a one-character name doesn't shrink to
// nothing and a long one doesn't blow the row out.
const compactSelectStyle = { ...selectStyle, width: 'auto', minWidth: 110, maxWidth: 200, flexGrow: 0 };

// One delivery on one date. Two different things happen here and they
// are deliberately kept apart:
//
//   - Changing what was already ordered (quantity, or skipping it) — an
//     override that touches this date only, never the standing
//     subscription.
//   - Adding something the customer doesn't normally take. A dairy that
//     now sells paneer, curd and ghee has customers who take milk daily
//     and ghee once a month; "Change" only ever knew about the one
//     product already on the order, so the answer to "she also wants
//     ghee today" was nothing at all. That's what "Add another item" is:
//     a one-off order for this customer on this date (the backend's
//     ad-hoc order path, which has existed unused since the beginning).
// onReorder, when given, turns on the ↑↓ controls. Only the screens that
// show a stop *in its route order* pass it — a stop listed under "not
// going out yet" has no position to move within.
export function StopCard({ stop, products = [], token, onChanged, onError, onReorder, canMoveUp, canMoveDown }) {
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [quantity, setQuantity] = useState(Number(stop.quantity) || 0);
  const [reason, setReason] = useState(stop.override_reason || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Errors belong next to the button that caused them, not in a banner at
  // the top of a page the admin has already scrolled away from — so this
  // is deliberately local and does not call up to onError.
  const report = (err) => setError(err.message);

  const save = async (changes) => {
    setBusy(true);
    setError('');
    try {
      await api.overrideOrder(token, stop.id, changes);
      setEditing(false);
      await onChanged();
    } catch (err) {
      report(err);
    } finally {
      setBusy(false);
    }
  };

  const statusTone = { delivered: 'success', failed: 'error', skipped: 'warning' }[stop.status] || 'neutral';

  return (
    <Card>
      <View style={styles.stopHeader}>
        <View style={styles.stopHeaderText}>
          <Text style={styles.stopName}>
            {stop.sequence > 0 ? `${stop.sequence}. ` : ''}
            {stop.customer_name}
          </Text>
          <Text style={styles.stopMeta}>
            {stop.quantity} × {stop.product_name}
            {stop.base_quantity > 0 && stop.quantity !== stop.base_quantity ? `  (usually ${stop.base_quantity})` : ''}
          </Text>
          {stop.customer_address ? <Text style={styles.stopAddress}>{stop.customer_address}</Text> : null}
          {stop.override_reason ? <Text style={styles.stopReason}>{stop.override_reason}</Text> : null}
        </View>
        <View style={styles.stopHeaderRight}>
          <Pill label={stop.status} tone={statusTone} />
          {/* Up and down rather than drag: a drag inside a scrolling list
              is unreliable on a phone, and this stack has no gesture
              precedent. See Docs/COMPROMISES.md. */}
          {onReorder ? (
            <View style={styles.moveButtons}>
              <Pressable
                onPress={() => onReorder(stop.sequence - 1)}
                disabled={!canMoveUp || busy}
                accessibilityRole="button"
                accessibilityLabel={`Move ${stop.customer_name} earlier`}
                style={({ pressed }) => [styles.moveButton, !canMoveUp && styles.moveButtonOff, pressed && styles.pressed]}
              >
                <Text style={[styles.moveGlyph, !canMoveUp && styles.moveGlyphOff]}>↑</Text>
              </Pressable>
              <Pressable
                onPress={() => onReorder(stop.sequence + 1)}
                disabled={!canMoveDown || busy}
                accessibilityRole="button"
                accessibilityLabel={`Move ${stop.customer_name} later`}
                style={({ pressed }) => [styles.moveButton, !canMoveDown && styles.moveButtonOff, pressed && styles.pressed]}
              >
                <Text style={[styles.moveGlyph, !canMoveDown && styles.moveGlyphOff]}>↓</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>

      <Banner message={error} />

      {editing ? (
        <View style={styles.editor}>
          <Stepper
            label={`${stop.product_name} for this date`}
            value={quantity}
            onChange={setQuantity}
            min={0}
            hint="Set it to zero to send nothing today."
          />
          <Field
            label="Reason (optional)"
            size="md"
            value={reason}
            onChangeText={setReason}
            placeholder="Away this week / wants extra"
          />
          <View style={styles.buttonRow}>
            <Button title="Save" onPress={() => save({ quantity, reason })} busy={busy} style={styles.flexButton} />
            <Button
              title="Cancel"
              variant="secondary"
              onPress={() => {
                setQuantity(Number(stop.quantity) || 0);
                setReason(stop.override_reason || '');
                setEditing(false);
              }}
              style={styles.flexButton}
            />
          </View>
          <Text style={styles.note}>This changes this date only. The customer&apos;s standing subscription stays exactly as it is.</Text>
        </View>
      ) : (
        <View style={styles.buttonRow}>
          <Button title="Change" variant="secondary" onPress={() => setEditing(true)} style={styles.flexButton} />
          {stop.status === 'skipped' ? (
            <Button
              title="Un-skip"
              variant="secondary"
              onPress={() => save({ status: 'pending', quantity: stop.base_quantity || 1 })}
              busy={busy}
              style={styles.flexButton}
            />
          ) : (
            <Button
              title="Skip"
              variant="danger"
              onPress={() => save({ status: 'skipped', reason: 'skipped by admin' })}
              busy={busy}
              style={styles.flexButton}
            />
          )}
          {stop.lat || stop.lng ? (
            <Button title="Map" variant="secondary" onPress={() => openNavigation(stop.lat, stop.lng, stop.customer_name)} style={styles.flexButton} />
          ) : null}
        </View>
      )}

      {products.length > 0 ? (
        <View style={styles.addItemSection}>
          <Disclosure compact open={adding} onToggle={() => setAdding((prev) => !prev)}>
            {adding ? 'Cancel' : '+ Add another item'}
          </Disclosure>
          {adding ? (
            <AddItemForm
              stop={stop}
              products={products}
              token={token}
              onError={report}
              onAdded={async () => {
                setAdding(false);
                await onChanged();
              }}
            />
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

// A one-off extra on this date: pick a product, pick how many, done. The
// customer's standing order is untouched — this creates its own delivery
// alongside it, which is why it shows up as a separate stop rather than
// changing the one above.
function AddItemForm({ stop, products, token, onError, onAdded }) {
  // Default to something the customer isn't already getting — the point
  // of this form is the *other* products, so preselecting the one already
  // on the order would be the one useless choice.
  const others = products.filter((product) => product.name !== stop.product_name);
  const choices = others.length > 0 ? others : products;
  const [productId, setProductId] = useState(choices[0]?.id || '');
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.createAdHocOrder(token, {
        customer_id: stop.customer_id,
        product_id: productId,
        quantity,
        date: stop.delivery_date,
      });
      setQuantity(1);
      await onAdded();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <Text style={styles.label}>Product</Text>
      <select value={productId} disabled={busy} onChange={(event) => setProductId(event.target.value)} style={productSelectStyle}>
        {choices.map((product) => (
          <option key={product.id} value={product.id}>
            {product.name}
            {product.unit ? ` (${product.unit})` : ''}
          </option>
        ))}
      </select>
      <Stepper label="How many" value={quantity} onChange={setQuantity} min={1} />
      <Button title="Add to this delivery" onPress={submit} busy={busy} disabled={!productId} />
      <Text style={styles.note}>
        A one-off for this date only — it doesn&apos;t change what they normally get.
      </Text>
    </View>
  );
}

// Same reasoning as the driver picker above: a real <select>, sized to
// its content rather than stretched, since a product name is a few words
// and not a paragraph.
const productSelectStyle = { ...selectStyle, width: 'auto', minWidth: 160, maxWidth: 280, flexGrow: 0 };

const styles = StyleSheet.create({
  note: { fontSize: 12, color: colors.hint, marginTop: spacing.sm, lineHeight: 17 },
  label: { fontSize: 13, fontWeight: '600', color: colors.label, marginTop: spacing.md, marginBottom: spacing.xs },
  addItemSection: { marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.xs },
  routeBox: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  routeHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  routeName: { fontSize: 15, fontWeight: '700', color: colors.text },
  routeMeta: { fontSize: 13, color: colors.subtitle, marginTop: spacing.xs },
  actionRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center', marginTop: spacing.md },
  rebuildButton: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  rebuildIcon: { fontSize: 18, color: colors.link, fontWeight: '700' },
  deleteButton: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  deleteIcon: { fontSize: 16, color: colors.error },
  routeStops: { marginTop: spacing.sm },
  stopHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexShrink: 0 },
  moveButtons: { flexDirection: 'row', gap: 2 },
  moveButton: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moveButtonOff: { opacity: 0.3 },
  moveGlyph: { fontSize: 15, fontWeight: '700', color: colors.link, lineHeight: 18 },
  moveGlyphOff: { color: colors.hint },
  pressed: { opacity: 0.6 },
  stopHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  stopHeaderText: { flex: 1, paddingRight: spacing.sm },
  stopName: { fontSize: 16, fontWeight: '700', color: colors.text },
  stopMeta: { fontSize: 14, color: colors.label, marginTop: 2 },
  stopAddress: { fontSize: 13, color: colors.subtitle, marginTop: 2 },
  stopReason: { fontSize: 13, color: colors.warning, marginTop: 2, fontStyle: 'italic' },
  editor: { marginTop: spacing.md },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, flexWrap: 'wrap' },
  flexButton: { flex: 1, minWidth: 110 },
});
