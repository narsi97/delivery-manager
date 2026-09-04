import { useEffect, useState } from 'react';
import { useWindowDimensions } from 'react-native';

// What the screen can actually hold.
//
// This app is used on a laptop in an office and on a phone in a van, and
// a couple of things that are right on one are wrong on the other. Rather
// than scatter magic numbers, the two questions worth asking have names.

// Below this, a customer card's title row cannot hold a name, a reorder
// pill and a row of badges side by side — see CustomersScreen, where
// trying to do so squeezed "G Pavani" into a column one letter wide.
export const NARROW = 700;

export function useNarrow(breakpoint = NARROW) {
  const { width } = useWindowDimensions();
  return width < breakpoint;
}

// Whether this is a finger rather than a mouse.
//
// It matters because HTML5 drag-and-drop — which is what reordering the
// roster uses — does not exist on touch. No amount of CSS makes a
// draggable attribute work under a thumb, so the honest thing is to stop
// telling people to drag and point at the controls that do work.
//
// Read once: a device does not grow a mouse halfway through a session,
// and a hook that re-checked on every render would be a media query
// listener per row.
export function useTouchOnly() {
  const [touch, setTouch] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return undefined;
    }
    const query = window.matchMedia('(hover: none) and (pointer: coarse)');
    setTouch(query.matches);
    const listen = (event) => setTouch(event.matches);
    // Safari only grew addEventListener on MediaQueryList recently.
    if (query.addEventListener) {
      query.addEventListener('change', listen);
      return () => query.removeEventListener('change', listen);
    }
    query.addListener(listen);
    return () => query.removeListener(listen);
  }, []);
  return touch;
}
