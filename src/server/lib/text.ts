import crypto from 'node:crypto';

const NOISE_WORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'for', 'at', 'in', 'on', 'to',
  'project', 'projects', 'new', 'proposed', 'phase', 'construction',
  'renovation', 'improvements', 'improvement', 'city', 'parish', 'county',
]);

/** Stable key for cheap first-pass dedupe of project names. */
export function matchKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !NOISE_WORDS.has(w))
    .sort()
    .join(' ')
    .trim();
}

export function factKey(category: string, label: string): string {
  return `${category}:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

/** Jaccard similarity over word sets. Cheap shortlist filter before asking the model. */
export function similarity(a: string, b: string): number {
  const sa = new Set(matchKey(a).split(' ').filter(Boolean));
  const sb = new Set(matchKey(b).split(' ').filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared++;
  return shared / (sa.size + sb.size - shared);
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']) {
      u.searchParams.delete(p);
    }
    let s = u.toString();
    if (s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}
