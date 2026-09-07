import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import * as api from './api';
import { Banner, Pill } from './components';
import { groupProducts } from './productGroups';
import { useNarrow } from './layout';
import { groupStopsByCustomer, StopCard } from './routeCards';
import { NumberCell, tableStyles } from './tableCells';
import { colors, radius, spacing } from './theme';

// A day's round as a table: a row per door, a column per thing being
// delivered, and the quantity where the two meet.
//
// It replaced a stack of cards. Thirty-eight doors was thirty-eight
// cards, each repeating a name, an address, a line per item and a row of
// controls — three screens of scrolling to answer "who takes 2 litres",
// which a column answers by being read down. The same question the
// interest optimizer's savings schedule answers by being a table rather
// than a list of periods.
//
// Two things make it worth the width:
//
//   - The quantities are typed straight into the cells, so changing what
//     goes to a door today is not a card to open and a form to fill.
//   - The last row sums each column, which is the load list. Nobody has
//     to add it up from the stops any more.
//
// Everything a card could do it can still do — the row opens onto the
// card itself (see StopCard), which is where a pin, a skip, a reason and
// a one-off extra live. The table is for reading; the card is for the
// occasional thing that needs a form.
export default function DayOrderTable({
  stops,
  products = [],
  token,
  onChanged,
  onError,
  onReorder,
  arranging,
  home,
  drivers,
  focusAreas = [],
}) {
  // On a phone the whole table is wider than the screen, so every pixel
  // the name column takes is a quantity column somebody has to scroll to
  // find. The written address is the first thing to go: it is in the
  // row's own card, and this table is for reading numbers across.
  const narrow = useNarrow();
  const [openDoor, setOpenDoor] = useState(null);
  const [busyCell, setBusyCell] = useState('');
  const [error, setError] = useState('');

  const doors = groupStopsByCustomer(stops);

  // Only what is actually going out today gets a column. Five sizes of
  // milk when the round is all 1 litre would be four columns of nothing,
  // and the answer to "she also wants curd" is the row's own card, not a
  // permanently empty column on every row. Docs/DESIGN.md, rule 4.
  const ordered = new Set(stops.map((s) => s.product_id));
  const columns = groupProducts(products.filter((p) => ordered.has(p.id))).flatMap((group) =>
    group.items.map((item) => ({
      id: item.id,
      // "500 ml" under a "Milk" heading is how the product list reads it,
      // and a column head has even less room than that does.
      label: item.size || item.name,
      group: group.name,
    })),
  );

  // A status column only on a day that has one. Before the van leaves,
  // every stop is pending and the column is the same word thirty-eight
  // times.
  const anyStatus = stops.some((s) => s.status && s.status !== 'pending');

  const quantityOf = (door, productId) => {
    const lines = door.filter((s) => s.product_id === productId && s.status !== 'skipped');
    if (lines.length === 0) {
      return null;
    }
    return lines.reduce((total, line) => total + (Number(line.quantity) || 0), 0);
  };

  // Typing over a cell changes this date and nothing else — the same
  // override the card's own editor makes. An empty cell is a door that
  // is not down for that product, so a number typed into one is a
  // one-off, created the way "add another item" creates it.
  const commit = async (door, productId, raw) => {
    const next = Number(raw);
    if (!Number.isFinite(next) || next < 0) {
      return;
    }
    const key = `${door[0].customer_id}:${productId}`;
    setBusyCell(key);
    setError('');
    try {
      const line = door.find((s) => s.product_id === productId && s.status === 'pending');
      if (line) {
        await api.overrideOrder(token, line.id, { quantity: next });
      } else if (next > 0) {
        await api.createAdHocOrder(token, {
          customer_id: door[0].customer_id,
          product_id: productId,
          quantity: next,
          date: door[0].delivery_date,
        });
      }
      await onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyCell('');
    }
  };

  const doorStatusOf = (door) => {
    const statuses = [...new Set(door.map((s) => s.status))];
    return statuses.length === 1 ? statuses[0] : 'part done';
  };

  const totals = columns.map((column) =>
    doors.reduce((sum, door) => sum + (quantityOf(door, column.id) || 0), 0),
  );

  return (
    <View style={styles.wrap}>
      <Banner message={error} />
      {/* Wide tables scroll rather than squash — a quantity column
          crushed to fit a phone is a table nobody can read. */}
      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.scroller}>
        <View>
          <View style={[tableStyles.row, tableStyles.head, tableStyles.rule, styles.headRow]}>
            <Text style={[tableStyles.headCell, styles.numColumn]}>#</Text>
            <Text style={[tableStyles.headCell, styles.nameColumn, narrow && styles.nameColumnNarrow]}>Customer</Text>
            {columns.map((column) => (
              <Text
                key={column.id}
                style={[tableStyles.headCell, tableStyles.figure, styles.qtyColumn]}
                numberOfLines={2}
              >
                {column.label}
              </Text>
            ))}
            {anyStatus ? <Text style={[tableStyles.headCell, styles.statusColumn]}>Status</Text> : null}
            <View style={arranging && onReorder ? styles.moveColumn : styles.menuColumn} />
          </View>

          {doors.map((door, index) => {
            const stop = door[0];
            const open = openDoor === (stop.customer_id || stop.id);
            const status = doorStatusOf(door);
            const hasPin = Number.isFinite(stop.lat) && Number.isFinite(stop.lng) && (stop.lat !== 0 || stop.lng !== 0);
            return (
              <View key={stop.customer_id || stop.id}>
                <View style={[tableStyles.row, tableStyles.rule, open && styles.rowOpen]}>
                  <Text style={[tableStyles.cell, tableStyles.figure, styles.numColumn, styles.numText]}>
                    {index + 1}
                  </Text>
                  <View style={[styles.nameColumn, narrow && styles.nameColumnNarrow]}>
                    <Text style={styles.nameText} numberOfLines={1}>
                      {stop.customer_name}
                    </Text>
                    {/* The address earns its line only when there is one,
                        and a door with no pin says so here rather than
                        making somebody open the row to find out. */}
                    {hasPin ? (
                      stop.customer_address && !narrow ? (
                        <Text style={styles.addressText} numberOfLines={1}>
                          {stop.customer_address}
                        </Text>
                      ) : null
                    ) : (
                      <Text style={styles.noPinText} numberOfLines={1}>
                        no pin yet
                      </Text>
                    )}
                  </View>
                  {columns.map((column) => {
                    const quantity = quantityOf(door, column.id);
                    const key = `${stop.customer_id}:${column.id}`;
                    return (
                      <View key={column.id} style={styles.qtyColumn}>
                        <NumberCell
                          value={quantity === null ? '' : String(quantity)}
                          empty="—"
                          width={QTY_WIDTH - 12}
                          busy={busyCell === key}
                          ariaLabel={`${column.group} ${column.label} for ${stop.customer_name}`}
                          onCommit={(raw) => commit(door, column.id, raw)}
                        />
                      </View>
                    );
                  })}
                  {anyStatus ? (
                    <View style={styles.statusColumn}>
                      {status === 'pending' ? null : (
                        <Pill label={status} tone={STATUS_TONE[status] || 'warning'} />
                      )}
                    </View>
                  ) : null}
                  {/* While the order is being changed, every row needs
                      its own handles — that is the whole job, and
                      opening a row to find them would make moving
                      twenty doors twenty round trips. The rest of the
                      time they are not there at all. Docs/DESIGN.md,
                      rule 3. */}
                  {arranging && onReorder ? (
                    <View style={styles.moveColumn}>
                      <Pressable
                        onPress={() => onReorder(door[0].id, door[0].sequence - 1)}
                        disabled={index === 0}
                        accessibilityRole="button"
                        accessibilityLabel={`Move ${stop.customer_name} earlier`}
                        style={({ pressed }) => [styles.moveButton, index === 0 && styles.moveOff, pressed && styles.pressed]}
                      >
                        <Text style={[styles.moveGlyph, index === 0 && styles.moveGlyphOff]}>↑</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => onReorder(door[door.length - 1].id, door[door.length - 1].sequence + 1)}
                        disabled={index === doors.length - 1}
                        accessibilityRole="button"
                        accessibilityLabel={`Move ${stop.customer_name} later`}
                        style={({ pressed }) => [
                          styles.moveButton,
                          index === doors.length - 1 && styles.moveOff,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text style={[styles.moveGlyph, index === doors.length - 1 && styles.moveGlyphOff]}>↓</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <Pressable
                      onPress={() => setOpenDoor(open ? null : stop.customer_id || stop.id)}
                      accessibilityRole="button"
                      accessibilityState={{ expanded: open }}
                      accessibilityLabel={`${open ? 'Close' : 'Open'} ${stop.customer_name}`}
                      style={({ pressed }) => [styles.menuColumn, styles.menuButton, pressed && styles.pressed]}
                    >
                      <Text style={styles.menuGlyph}>{open ? '▾' : '⋯'}</Text>
                    </Pressable>
                  )}
                </View>

                {/* The card, unchanged, under its own row. Skipping,
                    reasons, the pin and a one-off extra are all forms,
                    and a form does not belong in a cell. */}
                {open ? (
                  <View style={styles.expanded}>
                    <StopCard
                      stops={door}
                      position={index + 1}
                      products={products}
                      token={token}
                      onChanged={onChanged}
                      onError={onError}
                      home={home}
                      drivers={drivers}
                      focusAreas={focusAreas}
                      titled={false}
                    />
                  </View>
                ) : null}
              </View>
            );
          })}

          {/* What to put in the van. It was only ever worked out on the
              driver's own screen, after they asked to check in — an
              admin loading the crates had to add the column up
              themselves. */}
          {columns.length > 0 ? (
            <View style={[tableStyles.row, styles.totalsRow]}>
              <Text style={[tableStyles.cell, styles.numColumn]} />
              <Text style={[tableStyles.cell, styles.nameColumn, narrow && styles.nameColumnNarrow, styles.totalsLabel]}>
                {doors.length} {doors.length === 1 ? 'door' : 'doors'}
              </Text>
              {totals.map((total, i) => (
                <Text
                  key={columns[i].id}
                  style={[tableStyles.cell, tableStyles.figure, styles.qtyColumn, styles.totalsFigure]}
                >
                  {total || '—'}
                </Text>
              ))}
              {anyStatus ? <View style={styles.statusColumn} /> : null}
              <View style={arranging && onReorder ? styles.moveColumn : styles.menuColumn} />
            </View>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const STATUS_TONE = { delivered: 'success', failed: 'error', skipped: 'warning', 'part done': 'warning' };

const QTY_WIDTH = 84;

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.sm },
  // The row is wider than a phone, so the scroller has to be allowed to
  // grow past it rather than being told to fill it.
  scroller: { flexGrow: 1 },
  headRow: { borderTopLeftRadius: radius.sm, borderTopRightRadius: radius.sm },
  numColumn: { width: 34 },
  numText: { color: colors.hint, fontSize: 12 },
  nameColumn: { width: 190, paddingHorizontal: spacing.xs, minWidth: 0 },
  nameColumnNarrow: { width: 132 },
  nameText: { fontSize: 14, fontWeight: '700', color: colors.text },
  addressText: { fontSize: 11, color: colors.subtitle, marginTop: 1 },
  noPinText: { fontSize: 11, color: colors.warning, fontWeight: '600', marginTop: 1 },
  qtyColumn: { width: QTY_WIDTH, alignItems: 'flex-end', paddingHorizontal: spacing.xs },
  statusColumn: { width: 96, paddingHorizontal: spacing.xs, alignItems: 'flex-start' },
  menuColumn: { width: 40 },
  moveColumn: { width: 68, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 2 },
  moveButton: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  moveOff: { opacity: 0.35 },
  moveGlyph: { fontSize: 14, lineHeight: 16, fontWeight: '700', color: colors.link },
  moveGlyphOff: { color: colors.hint },
  menuButton: { alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  menuGlyph: { fontSize: 18, lineHeight: 20, color: colors.link, fontWeight: '700' },
  pressed: { opacity: 0.6 },
  rowOpen: { backgroundColor: colors.surfaceAlt },
  // The card sits inside the scroller, which is as wide as the widest
  // row — so it is pinned to the width of the screen rather than
  // stretching off the side of it.
  expanded: { width: '100%', maxWidth: 640, paddingVertical: spacing.xs },
  totalsRow: { borderTopWidth: 2, borderTopColor: colors.border, backgroundColor: colors.surfaceAlt },
  totalsLabel: { fontSize: 12, fontWeight: '700', color: colors.subtitle },
  totalsFigure: { fontSize: 14, fontWeight: '800', color: colors.text },
});
