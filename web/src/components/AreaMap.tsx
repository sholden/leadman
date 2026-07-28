import React from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export interface MapPin {
  id: string;
  lat: number;
  lng: number;
  label: string;
  tone?: 'discovered' | 'tracked' | 'other';
}

/**
 * Shows the search area: a center marker plus the radius circle, so he can see
 * exactly where the system will be looking. Click to move the center.
 * Uses plain Leaflet + OpenStreetMap tiles — no API key, no bundled marker assets.
 */
export function AreaMap({
  lat,
  lng,
  radiusMiles,
  onPick,
  pins = [],
  height = 320,
}: {
  lat: number;
  lng: number;
  radiusMiles: number;
  onPick?: (lat: number, lng: number) => void;
  pins?: MapPin[];
  height?: number;
}) {
  const el = React.useRef<HTMLDivElement>(null);
  const map = React.useRef<L.Map | null>(null);
  const circle = React.useRef<L.Circle | null>(null);
  const center = React.useRef<L.CircleMarker | null>(null);
  const pinLayer = React.useRef<L.LayerGroup | null>(null);
  const onPickRef = React.useRef(onPick);
  onPickRef.current = onPick;

  React.useEffect(() => {
    if (!el.current || map.current) return;

    const m = L.map(el.current, { scrollWheelZoom: false }).setView([lat, lng], 9);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(m);

    circle.current = L.circle([lat, lng], {
      radius: radiusMiles * 1609.34,
      color: '#b4552d',
      weight: 2,
      fillColor: '#b4552d',
      fillOpacity: 0.08,
    }).addTo(m);

    center.current = L.circleMarker([lat, lng], {
      radius: 7,
      color: '#b4552d',
      weight: 3,
      fillColor: '#fff',
      fillOpacity: 1,
    }).addTo(m);

    pinLayer.current = L.layerGroup().addTo(m);

    m.on('click', (e: L.LeafletMouseEvent) => {
      onPickRef.current?.(Number(e.latlng.lat.toFixed(6)), Number(e.latlng.lng.toFixed(6)));
    });

    map.current = m;

    // Leaflet measures its container on init. When the map is inside a grid or a
    // modal that lays out after mount, that measurement is wrong and any fitBounds
    // computed from it zooms to the wrong level. Re-measure, then fit.
    const settle = () => {
      m.invalidateSize();
      if (circle.current) {
        m.fitBounds(circle.current.getBounds(), { padding: [24, 24], maxZoom: 12 });
      }
    };
    const raf = requestAnimationFrame(settle);
    const timer = setTimeout(settle, 120);

    // Keep it correct through window resizes and sidebar/layout changes too.
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      ro.disconnect();
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep circle + center in sync with props.
  React.useEffect(() => {
    if (!map.current || !circle.current || !center.current) return;
    circle.current.setLatLng([lat, lng]).setRadius(radiusMiles * 1609.34);
    center.current.setLatLng([lat, lng]);
    map.current.fitBounds(circle.current.getBounds(), { padding: [24, 24], maxZoom: 12 });
  }, [lat, lng, radiusMiles]);

  // Redraw project pins.
  React.useEffect(() => {
    const layer = pinLayer.current;
    if (!layer) return;
    layer.clearLayers();
    for (const p of pins) {
      const color = p.tone === 'tracked' ? '#2f7d4f' : p.tone === 'discovered' ? '#a8730f' : '#6b6862';
      L.circleMarker([p.lat, p.lng], {
        radius: 5,
        color,
        weight: 2,
        fillColor: color,
        fillOpacity: 0.7,
      })
        .bindTooltip(p.label)
        .addTo(layer);
    }
  }, [pins]);

  return <div className="map" style={{ height }} ref={el} />;
}
