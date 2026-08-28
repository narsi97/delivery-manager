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
//
// Three optional props scope the map to a business's own operating area
// instead of the India-wide fallback below:
//   - home: {lat, lng} | null — the business's own depot/shop location.
//   - areas: [{lat, lng, radius_meters, active}] — its declared service
//     areas, each drawn as a translucent circle.
//   - previewRadiusMeters: number | null — draws (and live-updates) a
//     circle around the *current* pin, for the "add a service area" flow
//     where an admin is picking a radius and wants to see it as they type.
export default function MapPicker({ lat, lng, onChange, height = 260, home = null, areas = [], previewRadiusMeters = null }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const previewCircleRef = useRef(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // Read at mount time only (see the mount effect below) — home/areas
  // drive a one-time "fit the default view" and a static reference layer,
  // not something that should re-fit the map out from under an admin
  // who's mid-drag because a sibling list re-rendered.
  const homeRef = useRef(home);
  homeRef.current = home;
  const areasRef = useRef(areas);
  areasRef.current = areas;

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

    // Reference layer: each service area as a translucent circle, the
    // business's own home location as a plain (non-draggable) marker.
    // Built once from the props this component happened to mount with —
    // see homeRef/areasRef above for why this isn't reactive.
    const referenceShapes = [];
    for (const area of areasRef.current || []) {
      if (area.active === false) {
        continue;
      }
      referenceShapes.push(
        L.circle([area.lat, area.lng], {
          radius: area.radius_meters,
          color: colors.subtitle,
          weight: 1,
          fillOpacity: 0.06,
        }).addTo(map)
      );
    }
    if (homeRef.current) {
      referenceShapes.push(
        L.circleMarker([homeRef.current.lat, homeRef.current.lng], {
          radius: 7,
          color: colors.text,
          weight: 2,
          fillColor: '#fff',
          fillOpacity: 1,
        }).addTo(map)
      );
    }

    // No pin yet, but there's a home/service area to scope the default
    // view to — fit those bounds instead of the India-wide fallback
    // above. This is the fix for "zoom in/out over a vast area": a
    // business that has set up where it operates never has to re-find
    // itself on the map by hand.
    if (!hasPin && referenceShapes.length > 0) {
      const group = L.featureGroup(referenceShapes);
      map.fitBounds(group.getBounds(), { padding: [20, 20] });
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
      previewCircleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the marker in sync when lat/lng arrive from outside the map
  // itself (typed coordinates, "pin my current location"). Guarded
  // against re-applying the map's own just-fired click/drag position.
  //
  // Also keeps the live radius-preview circle (see previewRadiusMeters
  // above) in sync — with the pin as it moves, and with the radius field
  // as the caller types into it. That second half is deliberately not
  // gated behind the "did the pin actually move" guard below: the pin
  // can be perfectly still while the admin is only changing the number.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const hasPin = Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0);

    if (hasPin) {
      const current = markerRef.current?.getLatLng();
      const moved = !current || Math.abs(current.lat - lat) >= 1e-9 || Math.abs(current.lng - lng) >= 1e-9;
      if (moved) {
        placeMarker(map, [lat, lng]);
        map.setView([lat, lng], Math.max(map.getZoom(), 14));
      }
    }

    if (hasPin && previewRadiusMeters) {
      if (previewCircleRef.current) {
        previewCircleRef.current.setLatLng([lat, lng]);
        previewCircleRef.current.setRadius(previewRadiusMeters);
      } else {
        previewCircleRef.current = L.circle([lat, lng], {
          radius: previewRadiusMeters,
          color: colors.accent,
          weight: 2,
          fillOpacity: 0.08,
        }).addTo(map);
      }
    } else if (previewCircleRef.current) {
      previewCircleRef.current.remove();
      previewCircleRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lng, previewRadiusMeters]);

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
