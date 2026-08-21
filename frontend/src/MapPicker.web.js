import React, { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { colors, radius } from './theme';

// A pin drawn as an inline SVG data URI, not one of Leaflet's bundled PNG
// icons — those resolve to a relative image path that assumes a plain
// webpack/CRA asset pipeline, which Metro doesn't serve at the same URL,
// and the well-known symptom is a broken-image marker. A self-contained
// data: URI has no path to get wrong, and img-src already allows data:
// under the shared Caddy's CSP (see caddy/Caddyfile).
const PIN_SVG = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="42" viewBox="0 0 30 42">` +
    `<path d="M15 0C6.7 0 0 6.7 0 15c0 10.5 15 27 15 27s15-16.5 15-27C30 6.7 23.3 0 15 0z" fill="${colors.accent}"/>` +
    `<circle cx="15" cy="15" r="6" fill="#fff"/>` +
    `</svg>`
);
const pinIcon = L.icon({
  iconUrl: `data:image/svg+xml,${PIN_SVG}`,
  iconSize: [30, 42],
  iconAnchor: [15, 42],
});

// Center used only before any pin exists on this record — purely
// cosmetic, since the first click replaces it immediately.
const DEFAULT_CENTER = [20.5937, 78.9629]; // roughly the center of India

// Click-to-place, drag-to-adjust pin. Fires onChange(lat, lng) on every
// placement/drag — the caller decides whether that means "update local
// form state" (new customer) or "save immediately" (editing an existing
// one), matching how the existing "pin my current location" buttons
// already behave.
export default function MapPicker({ lat, lng, onChange, height = 260 }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const placeMarker = (map, latlng) => {
    if (markerRef.current) {
      markerRef.current.setLatLng(latlng);
      return;
    }
    markerRef.current = L.marker(latlng, { icon: pinIcon, draggable: true }).addTo(map);
    markerRef.current.on('dragend', () => {
      const pos = markerRef.current.getLatLng();
      onChangeRef.current(pos.lat, pos.lng);
    });
  };

  // Mounted once. Re-centering when lat/lng change from outside (typed
  // coordinates, "pin my current location") is handled by the effect
  // below rather than tearing the map down and rebuilding it.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) {
      return undefined;
    }

    const hasPin = Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0);
    const center = hasPin ? [lat, lng] : DEFAULT_CENTER;

    const map = L.map(containerRef.current, { center, zoom: hasPin ? 15 : 5 });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    if (hasPin) {
      placeMarker(map, center);
    }

    map.on('click', (event) => {
      placeMarker(map, event.latlng);
      onChangeRef.current(event.latlng.lat, event.latlng.lng);
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the marker in sync when lat/lng arrive from outside the map
  // itself (typed coordinates, "pin my current location"). Guarded
  // against re-applying the map's own just-fired click/drag position.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const hasPin = Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0);
    if (!hasPin) {
      return;
    }
    const current = markerRef.current?.getLatLng();
    if (current && Math.abs(current.lat - lat) < 1e-9 && Math.abs(current.lng - lng) < 1e-9) {
      return;
    }
    placeMarker(map, [lat, lng]);
    map.setView([lat, lng], Math.max(map.getZoom(), 14));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng]);

  return <View ref={containerRef} style={[styles.map, { height }]} />;
}

const styles = StyleSheet.create({
  map: {
    borderRadius: radius.md,
    overflow: 'hidden',
    marginTop: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
});
