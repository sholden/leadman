import { Router } from 'express';
import { config } from '../config.js';

export const geoRouter = Router();

/**
 * Thin proxy to OpenStreetMap Nominatim so the browser doesn't hit it directly
 * (their usage policy requires an identifying User-Agent) and so results can be
 * cached in one place. No API key needed.
 */
const cache = new Map<string, { at: number; body: unknown }>();
const TTL_MS = 24 * 60 * 60 * 1000;
let lastCall = 0;

geoRouter.get('/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 3) return res.status(400).json({ error: 'query too short' });

  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return res.json(hit.body);

  // Nominatim asks for max 1 request/second.
  const wait = Math.max(0, 1100 - (Date.now() - lastCall));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', q);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '6');
  url.searchParams.set('addressdetails', '1');

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': `Leadman/0.1 (${config.geocodeContact})`,
        'Accept-Language': 'en',
      },
    });
    if (!resp.ok) return res.status(502).json({ error: `geocoder returned ${resp.status}` });
    const raw = (await resp.json()) as {
      display_name: string;
      lat: string;
      lon: string;
      type: string;
    }[];
    const body = raw.map((r) => ({
      label: r.display_name,
      lat: Number(r.lat),
      lng: Number(r.lon),
      type: r.type,
    }));
    cache.set(key, { at: Date.now(), body });
    res.json(body);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'geocoding failed' });
  }
});
