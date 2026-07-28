import { db, newId, nowIso } from '../db/index.js';
import { runStructured } from '../ai/client.js';
import { discoverySchema, discoveryValidator } from '../ai/schemas.js';
import { boundingBox } from '../lib/geo.js';
import { normalizeUrl } from '../lib/text.js';
import { checkUrls } from '../lib/urlcheck.js';
import { parseJsonArray, type ProfileRow, type SourceRow, type WorkTypeRow } from '../lib/models.js';
import type { RunContext } from './runs.js';
import { activeWorkTypes, linkSourceWorkTypes } from './workTypes.js';

const SYSTEM = `You find *lead sources* for a design or construction firm: web pages that
repeatedly publish signals of upcoming work before that work is awarded.

A source is only good if it is a **listing page that keeps producing new items**.
A single article or one meeting's PDF is not a source; the index page that links to
them is.

Where to look depends entirely on the kind of work being hunted:
  - Public capital projects → council/school-board agendas, capital outlay and bond
    programs, formal RFQ/RFP portals, state facility-planning offices.
  - Public repair and replacement work → deferred-maintenance and facility-condition
    reports, small-purchase bid boards, emergency/consent agenda items, insurance and
    disaster-recovery programs.
  - Private multi-site rollout → planning commission and zoning/conditional-use
    dockets, site plan review agendas, building permit portals, business and trade
    press, brokerage/build-to-suit announcements, corporate investor materials and
    franchise disclosure.

Rules:
- Use web_search and web_fetch to VERIFY each URL actually loads and is the listing
  page you claim it is. Never invent URLs.
- Prefer the durable index page over a deep link to today's document.
- Tag every source with the work type keys it actually serves. A general council
  agenda page may serve several; a franchise-news site may serve only one.
- Do not return sources that only serve work types not in the list.
- Spread coverage across the jurisdictions in range rather than returning many pages
  from one city.`;

export interface DiscoveryOptions {
  hints?: string[];
  limit?: number;
  /** Focus the hunt on one specialization. Omit to cover all active work types. */
  workType?: WorkTypeRow | null;
}

export async function discoverSources(
  ctx: RunContext,
  profile: ProfileRow,
  opts: DiscoveryOptions = {},
): Promise<{ added: number; considered: number }> {
  const box = boundingBox(profile.center_lat, profile.center_lng, profile.radius_miles);
  const existing = db
    .prepare('SELECT name, url, jurisdiction, kind, status FROM sources WHERE profile_id = ?')
    .all(profile.id) as Pick<SourceRow, 'name' | 'url' | 'jurisdiction' | 'kind' | 'status'>[];

  const allTypes = activeWorkTypes(profile.id);
  // When focusing, still list the others so the model can tag a source that happens
  // to serve more than one — but tell it which one to hunt for.
  const focus = opts.workType ?? null;
  const jurisdictions = parseJsonArray(profile.jurisdictions);
  const limit = opts.limit ?? 12;

  const workTypeBlock = allTypes.length
    ? [
        `# Work types this firm chases (tag every source with the keys it serves)`,
        ...allTypes.map((t) => {
          const lines = [`- key: ${t.key}`, `  name: ${t.name}`];
          if (t.description) lines.push(`  what it is: ${t.description.replace(/\s+/g, ' ').trim()}`);
          if (t.source_strategy) lines.push(`  where it surfaces: ${t.source_strategy.replace(/\s+/g, ' ').trim()}`);
          const signals = parseJsonArray(t.lead_signals);
          if (signals.length) lines.push(`  early signals: ${signals.slice(0, 6).join('; ')}`);
          return lines.join('\n');
        }),
        '',
      ].join('\n')
    : '';

  const focusBlock = focus
    ? [
        `# FOCUS OF THIS PASS`,
        `Hunt specifically for sources that serve work type "${focus.key}" (${focus.name}).`,
        focus.source_strategy
          ? `Its leads surface here: ${focus.source_strategy.replace(/\s+/g, ' ').trim()}`
          : '',
        `Other work types are listed above only so you can tag a source that serves several.`,
        `Do not spend this pass on sources that serve only the other types.`,
        '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const prompt = [
    `# Firm profile`,
    profile.description.trim(),
    '',
    `# Search area`,
    `Centered on ${profile.center_label} (${profile.center_lat.toFixed(4)}, ${profile.center_lng.toFixed(4)}).`,
    `Radius: ${profile.radius_miles} miles. Approximate bounding box: ` +
      `N ${box.north.toFixed(3)}, S ${box.south.toFixed(3)}, E ${box.east.toFixed(3)}, W ${box.west.toFixed(3)}.`,
    jurisdictions.length
      ? `Known jurisdictions in range: ${jurisdictions.join(', ')}.`
      : `First determine which cities, parishes/counties, school districts, and agencies fall inside that radius.`,
    '',
    workTypeBlock,
    focusBlock,
    `# Sources already being monitored (do NOT return these again)`,
    existing.length
      ? existing.map((s) => `- [${s.status}] ${s.name} — ${s.url}`).join('\n')
      : '(none yet)',
    '',
    opts.hints?.length
      ? `# Specific gaps to close on this pass\n${opts.hints.map((h) => `- ${h}`).join('\n')}\n`
      : '',
    `# Task`,
    `Find up to ${limit} NEW lead sources inside the search area. Verify each one loads`,
    `before including it, tag it with the work type keys it serves, then call submit_sources.`,
  ]
    .filter(Boolean)
    .join('\n');

  const result = await runStructured({
    purpose: focus ? `discover_sources:${focus.key}` : 'discover_sources',
    system: SYSTEM,
    prompt,
    toolName: 'submit_sources',
    toolDescription: 'Report the verified lead sources you found.',
    inputSchema: discoverySchema,
    validator: discoveryValidator,
    budget: ctx.budget,
    research: true,
  });

  // The model is asked to verify each URL, but doesn't always. Confirm ourselves —
  // it's a plain HTTP request, so it costs nothing.
  const proposed = result.sources.map((s) => normalizeUrl(s.url));
  const checks = await checkUrls(proposed);
  const unreachable = [...checks.values()].filter(
    (c) => c.reachability === 'missing' || c.reachability === 'error',
  );
  if (unreachable.length) {
    ctx.log(`discovery: ${unreachable.length}/${proposed.length} proposed URL(s) did not resolve`);
  }

  const typeByKey = new Map(allTypes.map((t) => [t.key, t]));
  const seen = new Set(existing.map((s) => normalizeUrl(s.url)));
  const insert = db.prepare(
    `INSERT INTO sources
       (id, profile_id, name, url, kind, jurisdiction, description, discovery_reason,
        status, origin, score, next_scan_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ai', ?, ?, ?, ?)
     ON CONFLICT (profile_id, url) DO NOTHING`,
  );

  let added = 0;
  const now = nowIso();
  for (const s of result.sources) {
    const url = normalizeUrl(s.url);
    if (seen.has(url)) continue;
    seen.add(url);

    const check = checks.get(url);
    // A URL that doesn't resolve is never activated — it goes to the approval
    // queue with the reason attached, so a human sees it instead of the scheduler
    // burning tokens on a dead page.
    const reachable = check?.reachability === 'ok' || check?.reachability === 'protected';
    const status = reachable && s.confidence >= 65 ? 'active' : 'candidate';
    const reason =
      check && check.reachability !== 'ok'
        ? `${s.reason}\n\n[link check] ${check.note}`
        : s.reason;

    const id = newId();
    const info = insert.run(
      id,
      profile.id,
      s.name.slice(0, 200),
      url,
      s.kind,
      s.jurisdiction,
      s.description,
      reason,
      status,
      // Penalise the score of anything that failed its link check so it sorts last.
      reachable ? s.confidence : Math.min(s.confidence, 25),
      status === 'active' ? now : null,
      now,
      now,
    );
    if (info.changes === 0) continue;
    added++;

    // Tag the source with the specializations it serves. If the model tagged
    // nothing but we were focusing on one type, attribute it to that type.
    const keys = s.work_type_keys.filter((k) => typeByKey.has(k));
    const resolved = keys.length > 0 ? keys : focus ? [focus.key] : [];
    linkSourceWorkTypes(
      id,
      resolved.map((k) => typeByKey.get(k)!.id),
    );
  }

  ctx.log(
    `discovery${focus ? ` [${focus.key}]` : ''}: ${result.sources.length} proposed, ${added} added`,
  );
  return { added, considered: result.sources.length };
}
