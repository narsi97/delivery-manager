import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import * as api from './api';
import { Banner, Button, Card, Disclosure, Empty, Field, Pill, Stepper } from './components';
import { InlineLocationEditor } from './LocationPicker';
import { openNavigation } from './navigation';
import { WEEKDAYS } from './frequency';
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
  // Only for the door map's own context — the farm and the drivers'
  // finishing points, so a pin is placed against something recognisable
  // rather than against bare tiles. Both optional: the map is still a
  // map without them.
  home,
  drivers,
  // The service routes worth opening the pin editor on when this door
  // has none of its own — the round this stop is on, or the ones the
  // business runs. See MapPicker's focusAreas.
  focusAreas = [],
}) {
  const stop = stops[0];
  const [adding, setAdding] = useState(false);
  const [showingDoor, setShowingDoor] = useState(false);
  const hasPin = Number.isFinite(stop.lat) && Number.isFinite(stop.lng) && (stop.lat !== 0 || stop.lng !== 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Moving the pin is a change to the customer, not to today's delivery:
  // the door is where it is tomorrow too. Same call the day's map view
  // makes for the same edit.
  const saveDoor = async (lat, lng) => {
    await api.updateCustomer(token, stop.customer_id, { lat, lng });
    await onChanged();
  };

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
        {/* Always offered, and loudest on the doors that have no pin.
            It used to appear only once a customer had one, which put the
            control out of reach of exactly the deliveries that need it:
            "We don't know where they live" listed them, explained the
            problem, and then gave the admin nowhere to fix it. */}
        <Pressable
          onPress={() => setShowingDoor((prev) => !prev)}
          accessibilityRole="button"
          accessibilityState={{ expanded: showingDoor }}
          style={({ pressed }) => [styles.doorAction, !hasPin && styles.doorActionWanted, pressed && styles.pressed]}
        >
          <Text style={[styles.doorActionText, !hasPin && styles.doorActionWantedText]}>
            {showingDoor ? 'Hide map' : hasPin ? '📍 Map' : '📍 Drop a pin'}
          </Text>
        </Pressable>
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

      {/* Where the door is, not directions to it.
          This button used to hand the stop straight to Apple or Google
          Maps. That is the right thing in a driver's hand and the wrong
          thing in the office: an admin pressing "Map" on the day's list
          is checking a pin or fixing one that is on the wrong side of
          the street, and being thrown out of the app into a navigation
          app answers a question nobody asked. The map view of the same
          day already did the right thing — the address, the pin, and a
          way to move it — so this is that, in the card.
          Navigation is still one press away, for the times somebody in
          the office genuinely wants to look at the route there, and it
          is untouched on the driver's own screen. */}
      {showingDoor ? (
        <View style={styles.doorPanel}>
          {/* The written address is already the second line of this
              card, so it is not repeated here — printing it twice is
              what made a card about one delivery look like two. */}
          <InlineLocationEditor
            lat={stop.lat}
            lng={stop.lng}
            onSave={saveDoor}
            home={home}
            drivers={drivers}
            focusAreas={focusAreas}
            height={200}
          />
          {/* Nothing to navigate to until the pin exists. */}
          {hasPin ? (
            <Pressable
              onPress={() => openNavigation(stop.lat, stop.lng, stop.customer_name)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.navigateButton, pressed && styles.pressed]}
            >
              <Text style={styles.navigateText}>🧭 Navigate there</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {adding ? (
        <View style={styles.addItemSection}>
          {adding ? (
            <AddItemForm
              stop={stop}
              existing={stops}
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
function AddItemForm({ stop, existing = [], products, token, onError, onAdded }) {
  // Every product stays pickable: a customer on daily milk who wants an
  // extra bottle today for a guest is a real thing to ask for, and
  // hiding it would answer that by making it impossible. What changes is
  // the *default* — something they are not already down for, because
  // preselecting one they have is the one useless choice.
  const alreadyToday = new Set(existing.map((item) => item.product_id));
  const choices = products;
  const firstNew = products.find((product) => !alreadyToday.has(product.id));
  const [productId, setProductId] = useState((firstNew || products[0])?.id || '');
  const [quantity, setQuantity] = useState(1);
  // 'once' is today and nothing else; 'weekly' is a change to what they
  // always get. Both start here because the answer to "she also wants
  // curd" is sometimes "today" and sometimes "from now on", and having
  // only the first meant the second was done twice — once here and again
  // on the customer's card.
  const [kind, setKind] = useState('once');
  const [weekdays, setWeekdays] = useState([1, 2, 3, 4, 5, 6, 0]);
  const [busy, setBusy] = useState(false);

  // Something they are already down for is added *to that line* rather
  // than beside it. Two lines of the same product at one door is a
  // question the driver cannot answer from the van — is it two drops or
  // one of three? — and the honest answer is always one of three.
  //
  // Only a line still pending can absorb it. One already delivered or
  // skipped is a record of what happened, and adding to it would rewrite
  // this morning; that genuinely does need a second delivery.
  const sameProduct = existing.filter((item) => item.product_id === productId);
  // Only a one-off merges. A standing order is a different kind of fact
  // — it says what happens every week — so it is created, and today's
  // delivery follows from it.
  const mergeInto = kind === 'once' ? sameProduct.find((item) => item.status === 'pending') : null;
  const closed = !mergeInto && sameProduct.length > 0 ? sameProduct[0] : null;
  const merged = mergeInto ? Number(mergeInto.quantity) + Number(quantity) : 0;

  const submit = async () => {
    setBusy(true);
    try {
      if (mergeInto) {
        await api.overrideOrder(token, mergeInto.id, { quantity: merged });
      } else if (kind === 'weekly') {
        await api.createRecurringOrder(token, {
          customer_id: stop.customer_id,
          product_id: productId,
          quantity,
          weekdays,
        });
      } else {
        await api.createAdHocOrder(token, {
          customer_id: stop.customer_id,
          product_id: productId,
          quantity,
          date: stop.delivery_date,
        });
      }
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

      <Text style={styles.label}>How often</Text>
      <select value={kind} disabled={busy} onChange={(event) => setKind(event.target.value)} style={productSelectStyle}>
        <option value="once">Just today</option>
        <option value="weekly">Every week, from now on</option>
      </select>

      {kind === 'weekly' ? (
        <View style={styles.daysBlock}>
          <Text style={styles.label}>Which days</Text>
          <View style={styles.dayRow}>
            {WEEKDAYS.map((day) => {
              const on = weekdays.includes(day.value);
              return (
                <Pressable
                  key={day.value}
                  onPress={() =>
                    setWeekdays((prev) =>
                      prev.includes(day.value) ? prev.filter((d) => d !== day.value) : [...prev, day.value],
                    )
                  }
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  style={[styles.day, on && styles.dayOn]}
                >
                  <Text style={[styles.dayText, on && styles.dayTextOn]}>{day.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      {mergeInto ? (
        <Text style={styles.mergeNote}>
          They&apos;re already down for {mergeInto.quantity} × {mergeInto.product_name} today, so this is added to that
          line — the driver sees one delivery of {merged}, not two.
        </Text>
      ) : null}
      {closed ? (
        <Text style={styles.duplicateWarning}>
          Today&apos;s {closed.product_name} is already marked {closed.status}, so this goes on as a separate delivery.
        </Text>
      ) : null}
      <Button
        title={
          mergeInto
            ? `Make it ${merged} × ${mergeInto.product_name}`
            : kind === 'weekly'
              ? 'Save standing order'
              : 'Add to this delivery'
        }
        onPress={submit}
        busy={busy}
        disabled={!productId || (kind === 'weekly' && weekdays.length === 0)}
      />
      <Text style={styles.note}>
        {kind === 'weekly'
          ? 'From now on, on the days you picked — and it starts with this one.'
          : "For this date only — it doesn't change what they normally get."}
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
  daysBlock: { marginBottom: spacing.sm },
  dayRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  day: {
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  dayOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  dayText: { fontSize: 12, fontWeight: '700', color: colors.label },
  dayTextOn: { color: colors.accentText },
  mergeNote: {
    fontSize: 13,
    color: colors.subtitle,
    lineHeight: 19,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  duplicateWarning: {
    fontSize: 13,
    color: colors.warning,
    lineHeight: 19,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  doorPanel: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  navigateButton: {
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  navigateText: { fontSize: 13, fontWeight: '700', color: colors.link },
  // A door with no pin cannot be driven to, so the way to give it one is
  // the only thing on this card worth pressing.
  doorActionWanted: {
    backgroundColor: colors.warningBg,
    borderRadius: radius.md,
    paddingHorizontal: spacing.sm,
  },
  doorActionWantedText: { color: colors.warning },
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
