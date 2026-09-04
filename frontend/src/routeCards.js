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

// Every delivery for one customer at one door, in one entry.
//
// A customer taking milk and curd is two daily orders, and the list used
// to show two cards: same name, same address, its own number each. A
// driver goes to a door once. Grouped by customer and ordered by the
// earliest sequence at that door, so the numbering counts doors rather
// than line items.
export function groupStopsByCustomer(stops) {
  const doors = new Map();
  for (const stop of stops) {
    const key = stop.customer_id || stop.id;
    if (!doors.has(key)) {
      doors.set(key, []);
    }
    doors.get(key).push(stop);
  }
  return [...doors.values()]
    .map((items) => items.sort((a, b) => (a.sequence || 0) - (b.sequence || 0)))
    .sort((a, b) => (a[0].sequence || 0) - (b[0].sequence || 0));
}

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
export function StopCard({
  // Every delivery for one customer at one door, in sequence order. A
  // customer taking milk and curd is two daily orders, and this used to
  // be two cards — the same name, the same address, twice in the list,
  // with its own number each. A driver goes to a door once; "add another
  // item" made that worse by growing the list every time, which read as
  // the item landing on somebody else.
  stops,
  position = 0,
  products = [],
  token,
  onChanged,
  onError,
  onReorder,
  canMoveUp,
  canMoveDown,
}) {
  const stop = stops[0];
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Errors belong next to the button that caused them, not in a banner at
  // the top of a page the admin has already scrolled away from — so this
  // is deliberately local and does not call up to onError.
  const report = (err) => setError(err.message);

  const save = async (id, changes) => {
    setBusy(true);
    setError('');
    try {
      await api.overrideOrder(token, id, changes);
      await onChanged();
    } catch (err) {
      report(err);
    } finally {
      setBusy(false);
    }
  };

  // One badge for the door. Everything at the same state says it once;
  // a door part-delivered says so, which is the case worth a word.
  const statuses = [...new Set(stops.map((s) => s.status))];
  const doorStatus = statuses.length === 1 ? statuses[0] : 'part done';
  const statusTone =
    { delivered: 'success', failed: 'error', skipped: 'warning' }[doorStatus] ||
    (statuses.length > 1 ? 'warning' : 'neutral');

  return (
    <Card>
      <View style={styles.stopHeader}>
        <View style={styles.stopHeaderText}>
          <Text style={styles.stopName}>
            {position > 0 ? `${position}. ` : ''}
            {stop.customer_name}
          </Text>
          {stop.customer_address ? <Text style={styles.stopAddress}>{stop.customer_address}</Text> : null}
        </View>
        <View style={styles.stopHeaderRight}>
          <Pill label={doorStatus} tone={statusTone} />
          {/* Up and down rather than drag: a drag inside a scrolling list
              is unreliable on a phone, and this stack has no gesture
              precedent. See Docs/COMPROMISES.md. */}
          {onReorder ? (
            <View style={styles.moveButtons}>
              <Pressable
                onPress={() => onReorder(stops[0].sequence - 1)}
                disabled={!canMoveUp || busy}
                accessibilityRole="button"
                accessibilityLabel={`Move ${stop.customer_name} earlier`}
                style={({ pressed }) => [styles.moveButton, !canMoveUp && styles.moveButtonOff, pressed && styles.pressed]}
              >
                <Text style={[styles.moveGlyph, !canMoveUp && styles.moveGlyphOff]}>↑</Text>
              </Pressable>
              <Pressable
                onPress={() => onReorder(stops[stops.length - 1].sequence + 1)}
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

      {/* One row per thing being dropped off, each with its own
          controls: quantities and skips are per item, because "no curd
          today, milk as usual" is the ordinary case. */}
      {stops.map((item) => (
        <StopItem key={item.id} item={item} busy={busy} onSave={save} />
      ))}

      {/* The two things you do to the door rather than to one line of
          it, on one row and sized to their words — a full-width "Map"
          was the loudest control on a card about what to deliver. */}
      <View style={styles.doorActions}>
        {stop.lat || stop.lng ? (
          <Pressable
            onPress={() => openNavigation(stop.lat, stop.lng, stop.customer_name)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.doorAction, pressed && styles.pressed]}
          >
            <Text style={styles.doorActionText}>🧭 Map</Text>
          </Pressable>
        ) : null}
        {products.length > 0 ? (
          <Pressable
            onPress={() => setAdding((prev) => !prev)}
            accessibilityRole="button"
            accessibilityState={{ expanded: adding }}
            style={({ pressed }) => [styles.doorAction, pressed && styles.pressed]}
          >
            <Text style={styles.doorActionText}>{adding ? 'Cancel' : '+ Add another item'}</Text>
          </Pressable>
        ) : null}
      </View>

      {adding ? (
        <View style={styles.addItemSection}>
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

// One line of the order: what it is, how many, and — only once you ask
// — what to do about it.
//
// Every line used to carry a full-width Change and a full-width Skip. A
// customer taking three things meant six large buttons stacked down the
// card, and the thing an admin actually opens the list to read — what is
// going to this door — was buried between them. The line is the content;
// the controls are a tap away, which is the same bargain every other
// disclosure in this app makes.
//
// Its own state, so opening the curd does not also open the milk — they
// are separate deliveries that happen to share a door.
function StopItem({ item, busy, onSave }) {
  const [open, setOpen] = useState(false);
  const [quantity, setQuantity] = useState(Number(item.quantity) || 0);
  const [reason, setReason] = useState(item.override_reason || '');

  const done = item.status !== 'pending';
  const notes = [
    item.base_quantity === 0 ? 'one-off' : '',
    item.base_quantity > 0 && item.quantity !== item.base_quantity ? `usually ${item.base_quantity}` : '',
    // The backend writes "one-off order" into the reason field too;
    // saying it twice is the app telling you one fact in two voices.
    item.override_reason && item.override_reason !== 'one-off order' ? item.override_reason : '',
  ].filter(Boolean);

  return (
    <View style={styles.item}>
      <Pressable
        onPress={() => setOpen((prev) => !prev)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${item.quantity} ${item.product_name} — change or skip`}
        style={({ pressed }) => [styles.itemHead, pressed && styles.pressed]}
      >
        <View style={styles.itemHeadText}>
          <Text style={[styles.itemName, done && styles.itemNameDone]}>
            {item.quantity} × {item.product_name}
          </Text>
          {notes.length > 0 ? <Text style={styles.itemNote}>{notes.join(' · ')}</Text> : null}
        </View>
        {/* Only when it isn't the ordinary state — a "pending" badge on
            every line of every stop is a badge on nothing. */}
        {done ? <Pill label={item.status} tone={ITEM_TONE[item.status] || 'neutral'} /> : null}
        <Text style={styles.itemChevron}>{open ? '▾' : '▸'}</Text>
      </Pressable>

      {open ? (
        <View style={styles.editor}>
          <Stepper
            label={`${item.product_name} for this date`}
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
            <Button
              title="Save"
              onPress={async () => {
                await onSave(item.id, { quantity, reason });
                setOpen(false);
              }}
              busy={busy}
              style={styles.flexButton}
            />
            {item.status === 'skipped' ? (
              <Button
                title="Un-skip"
                variant="secondary"
                onPress={() => onSave(item.id, { status: 'pending', quantity: item.base_quantity || 1 })}
                busy={busy}
                style={styles.flexButton}
              />
            ) : (
              <Button
                title="Skip"
                variant="danger"
                onPress={() => onSave(item.id, { status: 'skipped', reason: 'skipped by admin' })}
                busy={busy}
                style={styles.flexButton}
              />
            )}
          </View>
          <Text style={styles.note}>
            This changes this date only. The customer&apos;s standing subscription stays exactly as it is.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const ITEM_TONE = { delivered: 'success', failed: 'error', skipped: 'warning' };

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
  item: { borderTopWidth: 1, borderTopColor: colors.border },
  itemHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingVertical: spacing.xs,
  },
  itemHeadText: { flex: 1 },
  itemName: { fontSize: 15, fontWeight: '600', color: colors.text },
  itemNameDone: { color: colors.subtitle, textDecorationLine: 'line-through' },
  itemNote: { fontSize: 12, color: colors.hint, marginTop: 1 },
  itemChevron: { fontSize: 14, fontWeight: '700', color: colors.link, width: 14, textAlign: 'center' },
  doorActions: {
    flexDirection: 'row',
    gap: spacing.md,
    flexWrap: 'wrap',
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  doorAction: { paddingVertical: spacing.xs },
  doorActionText: { fontSize: 14, fontWeight: '700', color: colors.link },
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
