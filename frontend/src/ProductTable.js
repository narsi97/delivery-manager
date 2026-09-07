import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import * as api from './api';
import { AddButton } from './components';
import DeleteButton from './DeleteButton';
import { formatQuantity, groupProducts } from './productGroups';
import { NumberCell, numberCellFocusStyle, numberCellStyle } from './tableCells';
import { colors, radius, spacing } from './theme';

// The product table, in the two places it belongs.
//
// It lives on Manage business, where prices and stock are set. It is
// also what the day board shows when a size is short — and the same
// table, not a summary of it, because the answer to "we are twenty
// litres light" is to go and change the number, and asking somebody to
// carry a shortfall to another screen to do that is asking them to
// remember it. One component, so the two can never drift apart.
//
// `demand` is what the day being shown adds up to, per product id. On
// Manage business that is today; on the day board it is whichever date
// the picker is on.
export default function ProductTable({
  products,
  demand,
  token,
  canDelete,
  canAdd,
  onChanged,
  onCreated,
  onError,
}) {
  return (
    <>
      {groupProducts(products).map((group) => (
        <ProductGroup
          key={group.key}
          group={group}
          demand={demand}
          token={token}
          canDelete={canDelete}
          canAdd={canAdd}
          onChanged={onChanged}
          onCreated={onCreated}
          onError={onError}
        />
      ))}
    </>
  );
}

// One thing the business sells, and the sizes it sells it in.
//
// A dairy's five milk products are one product in five sizes, and the
// names already say so — see productGroups.js. Drawn as a heading and a
// column, prices and stock line up under each other, which is what makes
// ₹30 against ₹60 a glance rather than two scrolls.
//
// A product with one size gets no heading. A heading above a single row
// is a heading about nothing.
function ProductGroup({ group, demand, token, canDelete, canAdd, onChanged, onCreated, onError }) {
  const [adding, setAdding] = useState(false);
  // One size is not a group. A heading, a count of "1 size" and four
  // column labels over a single row is more chrome than content — it
  // reads as its own name, the way it always did.
  const lone = group.items.length === 1;
  return (
    <View style={styles.productGroup}>
      {lone ? null : (
        <View>
          <View style={styles.productGroupHead}>
            <Text style={styles.productGroupName}>{group.name}</Text>
            <Text style={styles.productGroupCount}>
              {group.items.length} {group.items.length === 1 ? 'size' : 'sizes'}
            </Text>
            {/* A new size of something already sold is not the same
                decision as a new product, and it should not cost a trip
                to the form at the top of the card: the name is already
                known, so the only questions are how big and how much. */}
            {canAdd ? (
              <AddButton
                open={adding}
                onPress={() => setAdding((prev) => !prev)}
                label={adding ? `Close add a size of ${group.name}` : `Add a size of ${group.name}`}
              />
            ) : null}
          </View>
          {/* Three bare numbers in a row need saying once what they are.
              Once, at the top of the group — not on every line, which is
              what a list of cards was doing. */}
          <View style={styles.productRow}>
            <Text style={[styles.productSize, styles.productHeadCell]}>Size</Text>
            {/* The rupee sign moved up here when the cell became
                something you type in — a currency symbol inside an
                input is one more character to select around. */}
            <Text style={[styles.productCell, styles.productHeadCell]}>Price ₹</Text>
            <Text style={[styles.productCell, styles.productHeadCell]}>Stock</Text>
            <Text style={[styles.productCell, styles.productHeadCell]}>Today</Text>
          </View>
        </View>
      )}
      {group.items.map((product) => (
        <ProductRow
          key={product.id}
          product={product}
          label={lone ? product.name : product.size || product.name}
          neededToday={demand[product.id] || 0}
          token={token}
          canDelete={canDelete}
          onChanged={onChanged}
          onError={onError}
        />
      ))}
      {adding && canAdd ? (
        <AddSizeRow
          group={group}
          token={token}
          onDone={async (created) => {
            setAdding(false);
            await onCreated(created);
          }}
          onCancel={() => setAdding(false)}
          onError={onError}
        />
      ) : null}
    </View>
  );
}

// A new size, typed where the other sizes are.
//
// Shaped like the rows above it on purpose — size, price, and the same
// two columns left empty — so it reads as the next line of the table
// rather than as a form that happens to be underneath one. The unit
// comes from its siblings: a sixth size of milk is measured the way the
// other five are, and asking again would be asking somebody to repeat
// what the screen already knows.
function AddSizeRow({ group, token, onDone, onCancel, onError }) {
  const [size, setSize] = useState('');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);

  const name = `${group.name} ${size.trim()}`.trim();

  const submit = async () => {
    if (!size.trim()) {
      return;
    }
    setBusy(true);
    try {
      const rupees = Number(price);
      await api.createProduct(token, {
        name,
        unit: group.items[0]?.unit || '',
        price_cents: Number.isFinite(rupees) && rupees > 0 ? Math.round(rupees * 100) : 0,
      });
      await onDone(name);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.productBlock}>
      <View style={styles.productRow}>
        <input
          value={size}
          autoFocus
          placeholder="750ml"
          aria-label={`New size of ${group.name}`}
          disabled={busy}
          onChange={(event) => setSize(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              submit();
            } else if (event.key === 'Escape') {
              onCancel();
            }
          }}
          style={{ ...numberCellStyle, ...numberCellFocusStyle, ...addSizeNameStyle }}
        />
        <input
          value={price}
          inputMode="decimal"
          placeholder="Price"
          aria-label={`Price of the new size of ${group.name}`}
          disabled={busy}
          onChange={(event) => setPrice(event.target.value.replace(/[^0-9.]/g, ''))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              submit();
            } else if (event.key === 'Escape') {
              onCancel();
            }
          }}
          style={{ ...numberCellStyle, ...numberCellFocusStyle }}
        />
        {/* One control, sized like the ✕ it sits above, so the row keeps
            the table's columns. Cancelling is the heading's "✕ Cancel",
            which is already on screen and already says so — a second
            Cancel here would be the same word twice. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Add ${name}`}
          disabled={!size.trim() || busy}
          onPress={submit}
          style={({ hovered }) => [
            styles.addSizeGo,
            !size.trim() && styles.addSizeGoOff,
            hovered && size.trim() ? styles.addSizeGoHover : null,
          ]}
        >
          <Text style={[styles.addSizeGoText, !size.trim() && styles.addSizeGoTextOff]}>Add</Text>
        </Pressable>
      </View>
    </View>
  );
}

// One size, and the two numbers a business actually keeps changing.
//
// Edited in the table, not by opening a form. The row already showed
// price and stock as columns, so expanding it into fields called Price
// and In stock was the same table twice — and it shoved every size below
// it down the page, so a morning spent entering five stock counts was
// five open-type-save-close cycles for five numbers.
//
// Saving on blur with no Save button is what this app already does with
// a number: the coordinate boxes, the priority picker, the position in
// the round. See Docs/DESIGN.md.
//
// "Needed today" stays read-only. It is worked out from the round rather
// than typed, and it is what makes the stock number mean anything — 118
// needed against 120 in stock is a morning nobody has to think about.
function ProductRow({ product, label, neededToday, token, canDelete, onChanged, onError }) {
  const [busy, setBusy] = useState(false);

  const have = Number(product.stock_quantity) || 0;
  const short = neededToday > 0 && have < neededToday;

  const commit = async (changes) => {
    setBusy(true);
    try {
      await api.updateProduct(token, product.id, changes);
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.productBlock}>
      <View style={styles.productRow}>
        <Text style={styles.productSize} numberOfLines={1}>
          {label}
        </Text>
        <NumberCell
          value={product.price_cents > 0 ? String(product.price_cents / 100) : ''}
          empty="—"
          busy={busy}
          ariaLabel={`Price of ${product.name} in rupees`}
          onCommit={(raw) => {
            const rupees = Number(raw);
            const cents = Number.isFinite(rupees) && rupees > 0 ? Math.round(rupees * 100) : 0;
            if (cents !== product.price_cents) {
              commit({ price_cents: cents });
            }
          }}
        />
        <NumberCell
          value={String(have)}
          busy={busy}
          warn={short}
          ariaLabel={`Stock of ${product.name}`}
          onCommit={(raw) => {
            const next = Number(raw) || 0;
            if (next !== have) {
              commit({ stock_quantity: next });
            }
          }}
        />
        <Text style={[styles.productCell, styles.productCellRead, short && styles.productCellShort]}>
          {neededToday > 0 ? formatQuantity(neededToday) : '—'}
        </Text>
        {/* Only while the window is open, and only ever a ✕ — a size
            added by mistake is a small thing to undo, and it should not
            cost the row a column the rest of the year. */}
        {canDelete ? (
          <DeleteButton
            armed
            compact
            label={`Delete ${product.name}`}
            describe={async () =>
              `Deleting "${product.name}" removes the size from your list. It cannot be undone, and anything already delivered keeps it.`
            }
            onDelete={() => api.deleteProduct(token, product.id)}
            onDone={onChanged}
            onError={onError}
          />
        ) : null}
      </View>
    </View>
  );
}


// The size box in the add row: text, not a figure, so it gets the width
// of the column it will end up in rather than a number cell's.
const addSizeNameStyle = { width: 'auto', flex: 1, textAlign: 'left', fontVariantNumeric: 'normal' };

const styles = StyleSheet.create({
  productGroup: { marginBottom: spacing.md },
  productGroupHead: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, marginBottom: 2 },
  productGroupName: { fontSize: 16, fontWeight: '700', color: colors.text },
  productGroupCount: { fontSize: 12, color: colors.hint },
  productBlock: { borderTopWidth: 1, borderTopColor: colors.border },
  productRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 40,
  },
  // The size is the row's name and takes the slack; the three numbers
  // hold a fixed column each so they stack under one another down the
  // group. Tabular figures, or a 1 and a 4 shift the column.
  productSize: { flex: 1, fontSize: 14, fontWeight: '700', color: colors.text, minWidth: 0 },
  productCell: {
    width: 66,
    textAlign: 'right',
    fontSize: 14,
    color: colors.label,
    fontVariant: ['tabular-nums'],
  },
  productHeadCell: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.hint,
  },
  // The read-only column keeps the inputs' padding so its digits sit in
  // the same place theirs do.
  productCellRead: { paddingHorizontal: 6 },
  productCellShort: { color: colors.warning, fontWeight: '700' },
  addSizeGo: {
    // Pushed to the end of the row, past the columns this row leaves
    // empty, so it lands under the ✕ it stands in for.
    marginLeft: 'auto',
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
  },
  addSizeGoOff: { backgroundColor: colors.border },
  addSizeGoHover: { opacity: 0.9 },
  addSizeGoText: { fontSize: 13, fontWeight: '700', color: colors.accentText },
  addSizeGoTextOff: { color: colors.subtitle },
});
