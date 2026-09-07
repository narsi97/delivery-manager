import { useRef, useState } from 'react';

import { colors, radius, spacing } from './theme';

// A number you can type over, in a table.
//
// Bare until touched, then a box — so a column of them reads as figures
// rather than as a form. Commits on blur or Enter, abandons on Escape,
// and says nothing when the value has not actually changed.
export function NumberCell({ value, empty, warn, busy, width, ariaLabel, onCommit }) {
  const [typed, setTyped] = useState(null);
  const [focused, setFocused] = useState(false);
  // The blur handler closes over state as it was when the input last
  // rendered, which a paste followed straight away by a blur outruns —
  // the same ref LocationPicker keeps for its coordinate boxes.
  const typedRef = useRef(null);

  const done = () => {
    const raw = typedRef.current;
    typedRef.current = null;
    setTyped(null);
    setFocused(false);
    if (raw !== null && raw !== value) {
      onCommit(raw);
    }
  };

  return (
    <input
      value={typed === null ? value || (empty ?? '') : typed}
      inputMode="decimal"
      disabled={busy}
      aria-label={ariaLabel}
      onFocus={(event) => {
        setFocused(true);
        setTyped(value);
        typedRef.current = value;
        event.target.select();
      }}
      onChange={(event) => {
        const next = event.target.value.replace(/[^0-9.]/g, '');
        typedRef.current = next;
        setTyped(next);
      }}
      onBlur={done}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.target.blur();
        } else if (event.key === 'Escape') {
          typedRef.current = null;
          setTyped(null);
          event.target.blur();
        }
      }}
      style={{
        ...numberCellStyle,
        ...(focused ? numberCellFocusStyle : null),
        ...(warn && !focused ? numberCellWarnStyle : null),
        ...(width ? { width } : null),
      }}
    />
  );
}

// Bare until touched: a column of boxes would read as a form, and this
// is a table.
export const numberCellStyle = {
  width: 66,
  textAlign: 'right',
  fontSize: 14,
  color: colors.label,
  fontFamily: 'inherit',
  fontVariantNumeric: 'tabular-nums',
  borderWidth: 1,
  borderStyle: 'solid',
  borderColor: 'transparent',
  borderRadius: radius.sm,
  backgroundColor: 'transparent',
  paddingTop: 3,
  paddingBottom: 3,
  paddingLeft: 6,
  paddingRight: 6,
  outline: 'none',
  cursor: 'text',
};

export const numberCellFocusStyle = {
  borderColor: colors.accent,
  backgroundColor: colors.surface,
  color: colors.text,
};

export const numberCellWarnStyle = { color: colors.warning, fontWeight: '700' };

// The shape a table of figures wants around those cells: fixed-width
// columns so digits stack, a tinted head, and a hairline under every
// row. Shared, so the day's orders and the product list are recognisably
// the same object rather than two tables that happen to be near each
// other.
export const tableStyles = {
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  rule: { borderBottomWidth: 1, borderBottomColor: colors.border },
  head: { backgroundColor: colors.surfaceAlt },
  headCell: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.hint,
    paddingHorizontal: spacing.xs,
  },
  cell: { fontSize: 14, color: colors.label, paddingHorizontal: spacing.xs },
  figure: { textAlign: 'right', fontVariant: ['tabular-nums'] },
};
