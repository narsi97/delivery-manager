import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Banner, Pill, ViewToggle } from './components';
import { useNarrow } from './layout';
import { formatQuantity } from './productGroups';
import { groupStopsByCustomer, StopCard } from './routeCards';
import { tableStyles } from './tableCells';
import { colors, radius, spacing } from './theme';

// A day's round as a table: one row per door, in the order it is driven.
//
// It replaced a stack of cards. Thirty-eight doors was thirty-eight
// cards, each repeating a name, an address, a line per item and its own
// row of controls — three screens of scrolling to read one round. The
// same reason the interest optimizer draws its schedule as a table
// rather than as a list of periods.
//
// Four columns, and they are in the order somebody reads them: where the
// door comes in the round, who it is, what they are getting, and where
// to go. The position is on the left with its own arrows, because
// changing the order is done *while* reading the round rather than in a
// separate pass.
//
// The row's own trouble is on the row. A door with no pin cannot be put
// in order by the router, so its row is amber; a door with no written
// address either has nothing to go on at all, and that cell is red.
// Those are the two states worth colour on this screen.
export default function DayOrderTable({
  stops,
  products = [],
  token,
  onChanged,
  onError,
  onReorder,
  arranging,
  onViewChange,
  home,
  drivers,
  focusAreas = [],
}) {
  // Both versions are on the screen while the business decides which one
  // it wants to keep. See Docs/DESIGN.md — the table is the one to beat.
  const [view, setView] = useState('table');
  const narrow = useNarrow();
  const [openDoor, setOpenDoor] = useState(null);

  const doors = groupStopsByCustomer(stops);

  const chooseView = (next) => {
    setView(next);
    if (onViewChange) {
      onViewChange(next);
    }
  };

  const toggle = (
    <View style={styles.toggleRow}>
      <ViewToggle
        value={view}
        onChange={chooseView}
        options={[
          { value: 'table', label: 'Table' },
          { value: 'cards', label: 'Cards' },
        ]}
      />
    </View>
  );

  if (view === 'cards') {
    return (
      <View style={styles.wrap}>
        {toggle}
        {doors.map((door, index) => (
          <StopCard
            key={door[0].customer_id || door[0].id}
            stops={door}
            position={index + 1}
            products={products}
            token={token}
            onChanged={onChanged}
            onError={onError}
            onReorder={arranging && onReorder ? (position) => onReorder(door[0].id, position) : null}
            canMoveUp={index > 0}
            canMoveDown={index < doors.length - 1}
            home={home}
            drivers={drivers}
            focusAreas={focusAreas}
          />
        ))}
      </View>
    );
  }

  // What the van is carrying, as one line rather than a column each.
  // Milk in five sizes was five columns of mostly nothing; said as
  // "8 × 500 ml · 3 × 750 ml" it is one line that stays true however many
  // things the dairy sells.
  const loadLines = [];
  for (const stop of stops) {
    if (stop.status === 'skipped') {
      continue;
    }
    const found = loadLines.find((line) => line.id === stop.product_id);
    if (found) {
      found.quantity += Number(stop.quantity) || 0;
    } else {
      loadLines.push({ id: stop.product_id, name: stop.product_name, quantity: Number(stop.quantity) || 0 });
    }
  }

  const anyStatus = stops.some((s) => s.status && s.status !== 'pending');
  // A door where every item is skipped is not on the van today, so it is
  // not counted as one of the round's doors.
  const offToday = (door) => door.every((s) => s.status === 'skipped');
  const offDoors = doors.filter(offToday).length;
  const onDoors = doors.length - offDoors;

  return (
    <View style={styles.wrap}>
      {toggle}
      {/* Wide tables scroll rather than squash — an address crushed to
          fit a phone is an address nobody can read. */}
      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.scroller}>
        <View>
          <View style={[tableStyles.row, tableStyles.head, tableStyles.rule, styles.headRow]}>
            <Text style={[tableStyles.headCell, styles.posColumn]}>#</Text>
            <Text style={[tableStyles.headCell, styles.nameColumn, narrow && styles.nameColumnNarrow]}>Customer</Text>
            <Text style={[tableStyles.headCell, styles.orderColumn, narrow && styles.orderColumnNarrow]}>Order</Text>
            <Text style={[tableStyles.headCell, styles.addressColumn, narrow && styles.addressColumnNarrow]}>
              Address
            </Text>
            {anyStatus ? <Text style={[tableStyles.headCell, styles.statusColumn]}>Status</Text> : null}
            <View style={styles.menuColumn} />
          </View>

          {doors.map((door, index) => {
            const stop = door[0];
            const open = openDoor === (stop.customer_id || stop.id);
            const statuses = [...new Set(door.map((s) => s.status))];
            const status = statuses.length === 1 ? statuses[0] : 'part done';
            const hasPin = Number.isFinite(stop.lat) && Number.isFinite(stop.lng) && (stop.lat !== 0 || stop.lng !== 0);
            const hasAddress = !!(stop.customer_address || '').trim();
            const off = offToday(door);
            // The backend marks what a pause took with this reason, so a
            // hand skip and a paused household can be told apart.
            const paused = off && door.some((s) => s.override_reason === 'customer paused');
            return (
              <View key={stop.customer_id || stop.id}>
                <View
                  style={[
                    tableStyles.row,
                    tableStyles.rule,
                    styles.bodyRow,
                    // Amber says "this one cannot be put in order" — the
                    // router places a stop by its pin, so a door without
                    // one falls to the end of the round wherever its
                    // address happens to be.
                    !hasPin && styles.rowNoPin,
                    // Not going today outranks a missing pin: nobody is
                    // being sent there, so where it falls does not matter.
                    off && styles.rowOff,
                    open && styles.rowOpen,
                  ]}
                >
                  <View style={styles.posColumn}>
                    <Text style={styles.posNumber}>{index + 1}</Text>
                    {/* On the left, always. Reordering a round is done
                        while reading it — hiding the arrows behind a
                        mode meant seeing the list and changing it were
                        two different screens. */}
                    {onReorder && doors.length > 1 ? (
                      <View style={styles.moveStack}>
                        <Pressable
                          onPress={() => onReorder(door[0].id, door[0].sequence - 1)}
                          disabled={index === 0}
                          accessibilityRole="button"
                          accessibilityLabel={`Move ${stop.customer_name} earlier`}
                          style={({ pressed }) => [styles.moveButton, pressed && styles.pressed]}
                        >
                          <Text style={[styles.moveGlyph, index === 0 && styles.moveGlyphOff]}>▲</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => onReorder(door[door.length - 1].id, door[door.length - 1].sequence + 1)}
                          disabled={index === doors.length - 1}
                          accessibilityRole="button"
                          accessibilityLabel={`Move ${stop.customer_name} later`}
                          style={({ pressed }) => [styles.moveButton, pressed && styles.pressed]}
                        >
                          <Text style={[styles.moveGlyph, index === doors.length - 1 && styles.moveGlyphOff]}>▼</Text>
                        </Pressable>
                      </View>
                    ) : null}
                  </View>

                  {/* Said under the name rather than in the status
                      column, which on a phone is scrolled off the side. */}
                  <View style={[styles.nameColumn, narrow && styles.nameColumnNarrow]}>
                    <Text style={[styles.nameText, off && styles.nameOff]} numberOfLines={2}>
                      {stop.customer_name}
                    </Text>
                    {off ? <Text style={styles.offText}>{paused ? 'paused' : 'skipped today'}</Text> : null}
                  </View>

                  <View style={[styles.orderColumn, narrow && styles.orderColumnNarrow]}>
                    {door.map((item) => (
                      <Text
                        key={item.id}
                        style={[styles.orderText, item.status === 'skipped' && styles.orderSkipped]}
                        numberOfLines={1}
                      >
                        {formatQuantity(item.quantity)} × {item.product_name}
                      </Text>
                    ))}
                  </View>

                  {/* Nothing written down and no pin either is a door
                      nobody can be sent to, which is a different problem
                      from a door that merely has not been placed on the
                      map yet. */}
                  <View
                    style={[
                      styles.addressColumn,
                      narrow && styles.addressColumnNarrow,
                      styles.addressCell,
                      !hasAddress && styles.addressMissing,
                    ]}
                  >
                    {hasAddress ? (
                      <Text style={styles.addressText} numberOfLines={2}>
                        {stop.customer_address}
                      </Text>
                    ) : (
                      <Text style={styles.addressMissingText}>No address</Text>
                    )}
                    {!hasPin ? <Text style={styles.noPinText}>no pin</Text> : null}
                  </View>

                  {anyStatus ? (
                    <View style={styles.statusColumn}>
                      {status === 'pending' ? null : (
                        <Pill label={status} tone={STATUS_TONE[status] || 'warning'} />
                      )}
                    </View>
                  ) : null}

                  <Pressable
                    onPress={() => setOpenDoor(open ? null : stop.customer_id || stop.id)}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: open }}
                    accessibilityLabel={`${open ? 'Close' : 'Open'} ${stop.customer_name}`}
                    style={({ pressed }) => [styles.menuColumn, styles.menuButton, pressed && styles.pressed]}
                  >
                    <Text style={styles.menuGlyph}>{open ? '▾' : '⋯'}</Text>
                  </Pressable>
                </View>

                {/* The card, unchanged, under its own row. Changing a
                    quantity, skipping, dropping a pin and adding a
                    one-off are all forms, and a form does not belong in
                    a cell. */}
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

          {/* What to put in the van. It was worked out only on the
              driver's own screen, after they asked to check in — an
              admin filling crates had to add the round up by hand. */}
          {loadLines.length > 0 ? (
            <View style={[tableStyles.row, styles.totalsRow]}>
              <View style={styles.posColumn} />
              <Text style={[styles.totalsLabel, styles.nameColumn, narrow && styles.nameColumnNarrow]}>
                {onDoors} {onDoors === 1 ? 'door' : 'doors'}
                {offDoors > 0 ? ` · ${offDoors} off today` : ''}
              </Text>
              <View style={styles.totalsLoad}>
                {loadLines.map((line) => (
                  <Text key={line.id} style={styles.totalsText}>
                    {formatQuantity(line.quantity)} × {line.name}
                  </Text>
                ))}
              </View>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const STATUS_TONE = { delivered: 'success', failed: 'error', skipped: 'warning', 'part done': 'warning' };

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.sm },
  toggleRow: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: spacing.xs },
  // The rows are wider than a phone, so the scroller has to be allowed
  // to grow past it rather than being told to fill it.
  scroller: { flexGrow: 1 },
  headRow: { borderTopLeftRadius: radius.sm, borderTopRightRadius: radius.sm },
  bodyRow: { minHeight: 46, alignItems: 'stretch' },

  posColumn: { width: 70, flexDirection: 'row', alignItems: 'center', gap: 3, paddingLeft: spacing.xs },
  posNumber: { fontSize: 14, fontWeight: '700', color: colors.subtitle, width: 20, textAlign: 'right' },
  // Two arrows stacked in the height of one row is tight, so they get
  // the width instead: a wide, easy target either side of a small
  // glyph, rather than a small target around a small glyph.
  moveStack: { justifyContent: 'center' },
  moveButton: { paddingHorizontal: 7, paddingVertical: 2 },
  moveGlyph: { fontSize: 12, lineHeight: 13, color: colors.link, fontWeight: '700' },
  moveGlyphOff: { color: colors.border },

  nameColumn: { width: 160, paddingHorizontal: spacing.xs, minWidth: 0, alignSelf: 'center' },
  nameColumnNarrow: { width: 118 },
  nameText: { fontSize: 14, fontWeight: '700', color: colors.text },

  orderColumn: { width: 190, paddingHorizontal: spacing.xs, minWidth: 0, justifyContent: 'center' },
  orderColumnNarrow: { width: 140 },
  orderText: { fontSize: 13, color: colors.label, fontVariant: ['tabular-nums'] },
  orderSkipped: { textDecorationLine: 'line-through', color: colors.hint },

  addressColumn: { width: 250, minWidth: 0 },
  addressColumnNarrow: { width: 170 },
  addressCell: { paddingHorizontal: spacing.xs, justifyContent: 'center', alignSelf: 'stretch' },
  addressText: { fontSize: 12, color: colors.subtitle },
  addressMissing: { backgroundColor: colors.errorBg },
  addressMissingText: { fontSize: 12, fontWeight: '700', color: colors.error },
  noPinText: { fontSize: 11, fontWeight: '700', color: colors.warning, marginTop: 1 },

  statusColumn: { width: 96, paddingHorizontal: spacing.xs, justifyContent: 'center' },
  menuColumn: { width: 40 },
  menuButton: { alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' },
  menuGlyph: { fontSize: 18, lineHeight: 20, color: colors.link, fontWeight: '700' },

  pressed: { opacity: 0.6 },
  rowNoPin: { backgroundColor: colors.warningBg },
  rowOff: { backgroundColor: colors.pausedBg },
  nameOff: { color: colors.paused },
  offText: { fontSize: 11, fontWeight: '700', color: colors.paused, marginTop: 1 },
  rowOpen: { backgroundColor: colors.surfaceAlt },
  // The card sits inside the scroller, which is as wide as the widest
  // row — so it is pinned to a readable width rather than stretching off
  // the side of it.
  expanded: { width: '100%', maxWidth: 620, paddingVertical: spacing.xs },

  totalsRow: {
    borderTopWidth: 2,
    borderTopColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'flex-start',
    paddingVertical: spacing.xs,
  },
  totalsLabel: { fontSize: 12, fontWeight: '700', color: colors.subtitle },
  totalsLoad: { paddingHorizontal: spacing.xs },
  totalsText: { fontSize: 13, fontWeight: '700', color: colors.text, fontVariant: ['tabular-nums'] },
});
