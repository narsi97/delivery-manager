import React, { useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from './theme';

// Shared by TodayScreen (day status) and RoutesScreen (building/assigning
// routes) — both operate on "whichever date is selected," not just
// today, so both need the same picker. Each screen owns its own
// selectedDate state rather than sharing one across screens: that
// matches how every other screen in this app is independent (Customers,
// Drivers, Business don't share state either), and it means looking
// ahead to next Tuesday's routes doesn't strand the admin on next
// Tuesday when they flip back to check today's delivery count.
export function formatDate(date) {
  if (!date) {
    return 'Today';
  }
  // Parsed as UTC deliberately: the string is already the business's own
  // calendar day, so re-interpreting it in the device's zone could shift
  // the displayed date by one.
  const parsed = new Date(`${date}T00:00:00Z`);
  return parsed.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

// Moves a YYYY-MM-DD string by a number of days, staying in UTC
// throughout for the same reason formatDate parses in UTC — this is a
// calendar date, not an instant.
export function shiftDate(date, deltaDays) {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + deltaDays);
  return parsed.toISOString().slice(0, 10);
}

// date: the resolved date currently being shown (from the server
// response — empty until the first load completes).
// selectedDate: '' means "the business's own today" (server-resolved);
// a concrete YYYY-MM-DD once the admin has explicitly navigated.
export default function DateNav({ date, selectedDate, onSelect }) {
  const inputRef = useRef(null);

  // The native date input still does the actual picking — it's just not
  // shown as a text box any more. showPicker() is the standards way to
  // open it programmatically; browsers old enough to lack it still open
  // the picker on focus, so the fallback degrades rather than breaking.
  const openPicker = () => {
    const el = inputRef.current;
    if (!el) {
      return;
    }
    try {
      el.showPicker();
    } catch (err) {
      el.focus();
    }
  };

  return (
    <View>
      <View style={styles.dateNav}>
        <Pressable
          onPress={() => date && onSelect(shiftDate(date, -1))}
          accessibilityRole="button"
          accessibilityLabel="Previous day"
          style={styles.dateNavButton}
        >
          <Text style={styles.dateNavArrow}>‹</Text>
        </Pressable>
        <Text style={styles.dateHeading}>{formatDate(date)}</Text>
        <View style={styles.rightButtons}>
          <Pressable onPress={openPicker} accessibilityRole="button" accessibilityLabel="Pick a date" style={styles.dateNavButton}>
            <Text style={styles.calendarIcon}>📅</Text>
          </Pressable>
          <Pressable
            onPress={() => date && onSelect(shiftDate(date, 1))}
            accessibilityRole="button"
            accessibilityLabel="Next day"
            style={styles.dateNavButton}
          >
            <Text style={styles.dateNavArrow}>›</Text>
          </Pressable>
        </View>
      </View>
      {/* A real date input still backs the calendar icon above — it's
          just visually hidden instead of removed, so the browser's own
          native picker (which every admin already knows how to use) is
          what actually opens, not a picker this app built by hand. */}
      <input
        ref={inputRef}
        type="date"
        value={selectedDate || date || ''}
        onChange={(event) => onSelect(event.target.value)}
        style={hiddenDateInputStyle}
      />
      {selectedDate ? (
        <Pressable onPress={() => onSelect('')} accessibilityRole="button" style={styles.todayLink}>
          <Text style={styles.todayLinkText}>Jump to today</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// Zero footprint — kept in the layout (not display:none) so
// showPicker()/focus() still work in every browser, just invisible.
const hiddenDateInputStyle = {
  position: 'absolute',
  width: 1,
  height: 1,
  opacity: 0,
  border: 'none',
  padding: 0,
};

const styles = StyleSheet.create({
  dateNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  dateNavButton: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  dateNavArrow: { fontSize: 24, fontWeight: '700', color: colors.link },
  dateHeading: { fontSize: 17, fontWeight: '700', color: colors.text, flexShrink: 1 },
  rightButtons: { flexDirection: 'row', alignItems: 'center' },
  calendarIcon: { fontSize: 18 },
  todayLink: { alignSelf: 'flex-start', marginTop: spacing.xs },
  todayLinkText: { fontSize: 13, fontWeight: '700', color: colors.link },
});
