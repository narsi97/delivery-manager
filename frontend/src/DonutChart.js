import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from './theme';

// A day's delivery counts as one shape instead of six competing numbers.
// Plain inline SVG — same reasoning as MapPicker.web.js's hand-rolled pin
// icon: this app has no charting library, and a donut is a small enough
// shape not to need one. Raw <svg>/<circle> JSX renders directly through
// react-native-web exactly like the raw <select>/<input> elements already
// used elsewhere in this app (TodayScreen, RoutesScreen, DateNav).
//
// segments: [{ label, value, color }]. total is shown in the center —
// passed separately rather than summed from segments, since "total" on
// this screen includes every stop regardless of status, and the
// segments here are deliberately only the ones worth a color (pending
// stops are the "nothing has happened yet" majority in a fresh day and
// would otherwise dominate the chart with no useful signal).
export default function DonutChart({ segments, total, size = 120, strokeWidth = 18 }) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  let cumulative = 0;
  const arcs = segments
    .filter((segment) => segment.value > 0)
    .map((segment) => {
      const fraction = total > 0 ? segment.value / total : 0;
      const dash = fraction * circumference;
      const arc = { ...segment, dash, offset: -cumulative * circumference };
      cumulative += fraction;
      return arc;
    });

  return (
    <View style={styles.row}>
      <View style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle cx={center} cy={center} r={radius} fill="none" stroke={colors.muted} strokeWidth={strokeWidth} />
          {arcs.map((arc, index) => (
            <circle
              key={index}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={arc.color}
              strokeWidth={strokeWidth}
              strokeDasharray={`${arc.dash} ${circumference - arc.dash}`}
              strokeDashoffset={arc.offset}
              transform={`rotate(-90 ${center} ${center})`}
            />
          ))}
        </svg>
        <View style={styles.centerLabel} pointerEvents="none">
          <Text style={styles.centerValue}>{total}</Text>
          <Text style={styles.centerCaption}>Total</Text>
        </View>
      </View>
      <View style={styles.legend}>
        {segments.map((segment) => (
          <View key={segment.label} style={styles.legendRow}>
            <View style={[styles.dot, { backgroundColor: segment.color }]} />
            <Text style={styles.legendLabel}>{segment.label}</Text>
            <Text style={styles.legendValue}>{segment.value}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, flexWrap: 'wrap' },
  centerLabel: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerValue: { fontSize: 26, fontWeight: '800', color: colors.text },
  centerCaption: { fontSize: 11, color: colors.subtitle },
  legend: { flexGrow: 1, minWidth: 140, gap: spacing.xs },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
  legendLabel: { flex: 1, fontSize: 13, color: colors.label },
  legendValue: { fontSize: 13, fontWeight: '700', color: colors.text },
});
