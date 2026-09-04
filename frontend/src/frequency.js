// How often a standing order runs.
//
// The backend has always stored this per product: a RecurringOrder is
// one row per customer per product, each with its own weekday mask. So
// "milk every morning, curd every other day" was always expressible —
// the forms just asked the question once for the whole order and applied
// one answer to everything in it, which flattened anyone whose products
// ran on different days.
//
// Presets rather than seven checkboxes, because "every other day" is how
// a dairy customer says it and Mon/Wed/Fri is what they mean. The chips
// are still there behind "Chosen days", for the customer whose
// arrangement is genuinely their own.

// Monday first: the week starts on Monday for everyone arranging a milk
// round, whatever Date.getDay() thinks. The values are still JS weekday
// numbers, because that is what the mask is indexed by on both sides.
export const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

export const EVERY_DAY = [1, 2, 3, 4, 5, 6, 0];

// "Every other day" is Mon/Wed/Fri, not a true 48-hour interval. A real
// interval drifts through the week — this week's Tuesday is next week's
// Wednesday — which is not something a driver can hold in their head or
// a customer can plan around, and it is not what anybody means when they
// say it. The label says "every other day" and the description under it
// says which days, so nobody has to guess which reading they got.
export const PRESETS = [
  { value: 'daily', label: 'Every day', days: EVERY_DAY },
  { value: 'alternate', label: 'Every other day', days: [1, 3, 5] },
  { value: 'weekdays', label: 'Weekdays only', days: [1, 2, 3, 4, 5] },
  { value: 'weekends', label: 'Weekends only', days: [6, 0] },
  { value: 'custom', label: 'Chosen days…', days: null },
];

const sorted = (days) => WEEKDAYS.map((d) => d.value).filter((v) => days.includes(v));

// Which preset a set of days *is*, so reopening a form shows the name the
// admin picked rather than making them recognise their own chip pattern.
// Anything that matches no preset is custom, which is the honest answer.
export function presetFor(days) {
  const mine = sorted(days || []).join(',');
  const hit = PRESETS.find((p) => p.days && sorted(p.days).join(',') === mine);
  return hit ? hit.value : 'custom';
}

export function daysFromMask(mask) {
  return WEEKDAYS.map((d) => d.value).filter((v) => mask & (1 << v));
}

export function maskFromDays(days) {
  return (days || []).reduce((mask, day) => mask | (1 << day), 0);
}

export function sameDays(a, b) {
  return sorted(a || []).join(',') === sorted(b || []).join(',');
}

// A sentence for a card, not a form: "every day", "Mon, Wed and Fri".
export function describeDays(days) {
  const mine = sorted(days || []);
  if (mine.length === 0) {
    return 'never';
  }
  if (mine.length === 7) {
    return 'every day';
  }
  const names = mine.map((v) => WEEKDAYS.find((d) => d.value === v).label);
  if (names.length === 1) {
    return `${names[0]} only`;
  }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
