import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import * as api from './api';
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
  // What is in the cold room on `date`, keyed by product id. A product
  // missing from it has none — every day starts empty, so this is a
  // fact about a date and never about the product.
  stock = {},
  // Yesterday's figures, for anything nobody has entered today. Shown
  // muted and never counted — see handleProductDemand.
  suggested = {},
  date,
  token,
  canDelete,
  onChanged,
  onError,
}) {
  const [busy, setBusy] = useState(false);
  const offered = Object.keys(suggested).filter((id) => products.some((p) => p.id === id));

  const acceptAll = async () => {
    setBusy(true);
    try {
      await api.setAllProductStock(token, date, suggested);
      await onChanged();
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* One press for a dairy that fills the same amount most mornings.
          It writes today's figures rather than counting yesterday's, so
          what the app then believes is something a person said. */}
      {offered.length > 0 ? (
        <View style={styles.carryRow}>
          <Text style={styles.carryText}>
            Nothing entered for this day. Yesterday&apos;s figures are shown faintly.
          </Text>
          <Pressable
            onPress={acceptAll}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Use yesterday's stock for this day"
            style={({ pressed }) => [styles.carryButton, pressed && styles.carryPressed]}
          >
            <Text style={styles.carryButtonText}>{busy ? 'Saving…' : 'Same as yesterday'}</Text>
          </Pressable>
        </View>
      ) : null}

      {groupProducts(products).map((group) => (
        <ProductGroup
          key={group.key}
          group={group}
          demand={demand}
          stock={stock}
          suggested={suggested}
          date={date}
          token={token}
          canDelete={canDelete}
          onChanged={onChanged}
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
function ProductGroup({ group, demand, stock, suggested, date, token, canDelete, onChanged, onError }) {
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
            {/* Not "Today" — this table also draws tomorrow, and the
                day it means is the one the page is on. */}
            <Text style={[styles.productCell, styles.productHeadCell]}>Needed</Text>
          </View>
        </View>
      )}
      {group.items.map((product) => (
        <ProductRow
          key={product.id}
          product={product}
          label={lone ? product.name : product.size || product.name}
          neededToday={demand[product.id] || 0}
          inStock={stock[product.id] || 0}
          suggestedStock={suggested[product.id]}
          entered={product.id in stock}
          date={date}
          token={token}
          canDelete={canDelete}
          onChanged={onChanged}
          onError={onError}
        />
      ))}
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
// "Needed" stays read-only. It is worked out from the round rather than
// typed, and it is what makes the stock number mean anything — 118
// needed against 120 in stock is a morning nobody has to think about.
//
// Stock is written against the date this table is showing, not onto the
// product: a churn that came in on Monday is Monday's.
function ProductRow({ product, label, neededToday, inStock, suggestedStock, entered, date, token, canDelete, onChanged, onError }) {
  const [busy, setBusy] = useState(false);

  const have = Number(inStock) || 0;
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
          value={entered ? String(have) : ''}
          empty="0"
          suggestion={suggestedStock === undefined ? '' : String(suggestedStock)}
          busy={busy}
          warn={short}
          ariaLabel={`Stock of ${product.name}`}
          onCommit={async (raw) => {
            const next = Number(raw) || 0;
            if (next === have) {
              return;
            }
            setBusy(true);
            try {
              await api.setProductStock(token, product.id, date, next);
              await onChanged();
            } catch (err) {
              onError(err.message);
            } finally {
              setBusy(false);
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



const styles = StyleSheet.create({
  carryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  carryText: { flex: 1, minWidth: 160, fontSize: 12, color: colors.subtitle },
  carryButton: {
    paddingVertical: 7,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.surface,
  },
  carryPressed: { opacity: 0.7 },
  carryButtonText: { fontSize: 13, fontWeight: '700', color: colors.accent },
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
});
