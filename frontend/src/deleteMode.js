import { useEffect, useState } from 'react';

import * as api from './api';

// Is the delete window open, and for how much longer.
//
// The app hides the buttons; the server is what actually refuses (see
// backend deletemode.go). This is only about not showing somebody a
// control that would be turned down — which matters, because a button
// that fails is worse than a button that is not there.
//
// The window closes on its own, so the hook watches the clock rather
// than waiting for the next page load. A minute is plenty: this is a
// safety catch measured in hours, and a ticking second hand would be
// the app drawing attention to itself for no reason.
const TICK_MS = 60 * 1000;

export function isOpen(until) {
  return !!until && new Date(until).getTime() > Date.now();
}

export function useDeleteMode(user) {
  const until = user?.delete_mode_until || null;
  const [open, setOpen] = useState(() => isOpen(until));

  useEffect(() => {
    setOpen(isOpen(until));
    if (!until) {
      return undefined;
    }
    const timer = setInterval(() => setOpen(isOpen(until)), TICK_MS);
    return () => clearInterval(timer);
  }, [until]);

  return { open, until };
}

// "until 14:32" — the time, not a countdown. Somebody who turned this on
// for an hour wants to know when it lapses, and a number counting down
// invites watching it.
export function describeUntil(until) {
  if (!until) {
    return '';
  }
  const at = new Date(until);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export const WINDOWS = [
  { hours: 1, label: '1 hour' },
  { hours: 4, label: '4 hours' },
  { hours: 24, label: '1 day' },
];

export async function arm(token, hours) {
  return api.setDeleteMode(token, hours);
}

export async function disarm(token) {
  return api.setDeleteMode(token, 0);
}
