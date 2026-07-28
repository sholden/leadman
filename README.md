# Leadman

Finds and tracks new-building-project leads for a small architecture firm.

You describe the kind of work you want and the area you'll travel to. Leadman then
goes and finds the places that publish news of upcoming projects — council and
school-board agendas, RFP portals, bid boards, capital plans, permit feeds, local
trade press — watches them on a schedule, and pulls out projects that match your
description. When you decide a lead is worth chasing, it goes digging for the
timeline, the budget, who's already involved, and who to call.

Everything runs on your own machine. Data lives in a single SQLite file.

---

## Setup

```bash
npm install
cp .env.example .env      # then put your Anthropic API key in it
npm start                 # builds the UI and starts the server
```

Open **http://localhost:8787**.

For development with hot reload, `npm run dev` instead (UI on :5173, API on :8787).

You need an API key for whichever vendor you pick — Anthropic or OpenAI (see
**Model providers** below). Nothing else: the maps use OpenStreetMap and the
geocoder is Nominatim, neither of which needs a key.

## Model providers

Leadman runs on either **Anthropic** or **OpenAI**. Choosing the model in Settings
chooses the vendor with it — the app routes on the model id, so a mismatched
provider setting can't silently send Claude traffic to OpenAI or vice versa.

| Model | Vendor | Key |
|---|---|---|
| `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5` | Anthropic | `ANTHROPIC_API_KEY` |
| `gpt-5.2`, `gpt-5.1`, `gpt-5`, `gpt-5-mini`, `o4-mini` | OpenAI | `OPENAI_API_KEY` |

Both providers are given the same three capabilities, so every job works either
way: web search, URL reading, and a strict schema-checked "submit" tool that
carries the answer back.

**One difference worth knowing.** Anthropic has a hosted `web_fetch` tool; OpenAI
does not. On OpenAI, URL reading is a client-side `fetch_url` tool backed by
Leadman's own fetcher — the same code that powers the archive, so it gets
HTML-to-text and real PDF extraction. In practice that means OpenAI reads agenda
PDFs just as well, but fetching happens from your machine rather than the
vendor's, so pages that block your IP behave differently than they would on
Anthropic. The document limits in Settings apply to both.

Model pricing lives in one table in `src/server/config.ts` — update it there if
list prices change; the budget guard and spend display both read from it.

## First run

1. **Profiles → New profile.** Describe the firm and set the center and radius on
   the map.
2. **Add your work types.** This is the important step. A profile says who you are;
   a work type says what you chase — and different specializations surface in
   completely different places. Add one per specialization, describing what counts,
   how early you want to hear about it, and what to exclude.
3. **Press "Find sources for this"** on a work type (or "Find sources now" for a
   general pass). It searches the web, verifies each page loads,
   and adds the ones it's confident about as active sources. Less certain finds
   land in *Awaiting approval* on the Sources page for you to eyeball.
4. **Dashboard → "Run a pass now"**, or just leave it — the scheduler wakes up
   every 30 minutes on its own.
5. New leads appear on the Dashboard, each labelled with the work type it belongs
   to. Open one; if it's worth pursuing, press **Track this project** and the
   research passes begin.

## Work types

A profile describes the firm. A **work type** describes one thing the firm chases,
and it is what makes the hunt specific.

When you add one, a cheap planning call (no web search, a few cents) works out
*where that kind of work actually surfaces* and stores the strategy — you can read
it under "How the system hunts for this". The difference is not cosmetic. Given the
same Baton Rouge firm:

| "Roof replacement — large institutional buildings" | "Car wash chain rollout" |
|---|---|
| School board buildings-and-grounds committee items | Planning commission & board of adjustment conditional-use filings |
| Facility condition assessments, deferred maintenance lists | Secretary of State filings for new brand-plus-geography LLCs |
| FEMA Public Assistance and GOHSEP hazard-mitigation awards | Clerk of Court conveyance records for ~1-acre outparcels |
| Insurance-proceeds resolutions, State Bond Commission agendas | Franchise disclosure documents, net-lease offering memoranda |

Those two lists have nothing in common, and a single generic search finds only the
first kind. That strategy then drives three things:

- **Discovery** hunts one work type at a time, using its strategy, and tags each
  source with the specializations it serves (many-to-many — a council agenda page
  can serve several).
- **Scanning** classifies every project it finds into a work type. Anything
  matching none of them is dropped rather than saved, and the count is recorded in
  the scan notes. That is the point: a roofing specialist should not have to wade
  past new-gymnasium leads.
- **Assessment** measures coverage *per work type* and aims the next discovery pass
  at whichever specialization is starved, instead of piling more sources onto the
  one that already works.

Work types are optional. With none defined, the system behaves as it did before and
scores everything against the profile description alone.

If a scan puts a lead in the wrong bucket, fix it on the project page — the
classification is a dropdown.

The first pass on a new profile takes several minutes and costs roughly $2–5.

## How it decides what to do

Each scheduler pass, per profile:

**Coverage review** (every 72h by default) — it looks at every source it has, how
many scans each one has had, and what each has actually produced, then judges
whether the source set is adequate. If it finds a gap ("no coverage of West Baton
Rouge Parish school board agendas") it immediately goes looking to fill it. If a
source has been scanned a dozen times and never produced anything, it gets retired.

**Scanning** — sources come due on their own schedules. A source that produces
gets checked more often; one that keeps coming up empty backs off, up to a 30-day
ceiling. Best-performing sources are scanned first, so if the pass runs out of
budget the good ones have already run.

**Deduplication** — the same project shows up in a council agenda, a bid board,
and the local paper under three different names. Obvious duplicates are collapsed
by name; genuinely ambiguous pairs ("New Central Fire Station" vs "Fire Station
No. 3 Replacement") go to the model to judge, with a bias toward treating them as
separate — a duplicate is easier to merge later than a bad merge is to split.
Every source that mentions a project gets linked to it.

**Research** (tracked projects only) — goes beyond the source it was found in:
the owner's own site, procurement portals, permit records, board packets, news.
Findings are stored as discrete facts with the URL that supports each one. When a
value changes — a bid date slips — the old value is kept and marked superseded, so
you can see the project moving.

**Archiving** — a text snapshot of every page a finding came from is stored
locally, so the evidence survives the agenda getting rotated off the site.

## Activity

The **Activity** page answers "what is it doing, and what has it actually found?".

- **Working now** — any run in progress, with the step it's on right now and its
  events appearing live. It polls while something is running, so a 10-minute
  discovery pass shows movement rather than a spinner.
- **Past work** — every run with what it produced (sources found, sources scanned,
  new leads, facts researched), how long it took, and what it cost. Expand any run
  for its full timeline: each step timestamped, each find linked to the project or
  source it created, with the supporting detail one click away.
- **7-day totals** across the top.

Events are written to the database as they happen rather than buffered until the
run ends — that was the difference between being able to watch a pass and only
seeing a wall of text afterwards. Runs left mid-flight by a restart are marked
interrupted at boot rather than showing as active forever.

## Spending controls

Two hard caps, both in **Settings**:

- **Per-run budget** (default $4) — one scheduled pass or one manual action.
- **Monthly budget** (default $40) — calendar month, all activity.

The check runs *before* every model call. Because one agentic turn reading a dozen
PDF agendas can cost several dollars on its own, each call is additionally given a
**task budget** — a token allowance derived from the remaining run budget, which
the model sees and paces itself against. Without it a single call was measured at
$4.54, overshooting a $4 per-run cap outright.

When a cap is hit, work stops cleanly and is recorded as `budget_stopped` rather
than as an error. Settings shows spend broken down by activity and by day.

**The per-run cap is a firm ceiling, not an exact one.** A task budget bounds what
the model generates and reads, but not the conversation history the agentic loop
re-sends on each iteration — which you are still billed for. A measured run
overshot a $4 cap by about 20% even with the budget applied. The allowance is
discounted to compensate; treat the cap as ±25%, not exact. The monthly cap is
checked against actual recorded spend and does not have this problem.

Real measured costs on a 60-mile Baton Rouge profile:

| Activity | Cost | Time |
|---|---|---|
| Coverage assessment alone | $0.16 | ~1 min |
| Planning one work type (no web search) | $0.07–0.22 | ~30s |
| General source discovery (10 sources) | $1.92 | ~6 min |
| Work-type-targeted discovery | $2.75–4.89 | ~8–14 min |
| One scan of a council agenda page | $4.54 | ~5 min |
| One research pass on a tracked project | $6.13 | ~8 min |

Assessment is nearly free on its own; when it costs more it is because it decided to
go find sources, and that discovery is where the money went.

### The strongest cost dial

~90% of spend is input tokens — documents being read, not the model thinking. The
three **web tool limits** in Settings control that directly:

| Setting | Default |
|---|---|
| Max documents opened per call | 6 |
| Max tokens read per document | 25,000 |
| Max web searches per call | 8 |

Measured effect of dropping these from 12 / 40,000 / 12 to the current defaults, on
two comparable work-type-targeted discovery runs: **886k → 498k input tokens,
$4.89 → $2.75 — a 44% saving** with no observable drop in quality (the cheaper run
found four good sources that filled gaps the assessment had named, all reachable).

Raise them if you want deeper reading per pass; lower them to cut spend further.

Costs are estimated locally from token counts and published prices — close to your
Anthropic invoice, but not identical. Treat the caps as a safety rail, not
accounting.

Other knobs worth knowing: **sources scanned per pass** and **projects researched
per pass** are the main levers on both speed and cost. **Minimum relevance**
controls how picky it is before saving a lead at all.

To browse without spending anything, set `LEADMAN_SCHEDULER=off` in `.env`.

## Layout

```
src/server/
  ai/          model client, strict output schemas, budget guard
  jobs/        discoverSources · assessCoverage · scanSource · researchProject · scheduler
  routes/      REST API
  lib/         geo math, text/dedupe helpers, page archiver
  db/          SQLite schema + migration
web/src/       React UI (dashboard, profiles + map, sources, projects, settings)
scripts/       verification scripts (see below)
```

The model is reached through one wrapper (`ai/client.ts`) that gives it Anthropic's
hosted web search and web fetch tools plus exactly one client-side "submit" tool
carrying a strict JSON schema. It loops until the model submits, retrying with the
validation errors if the output doesn't match. Every call passes through the budget
guard first and is written to a usage ledger after.

## Tests

```bash
npm test              # 130 tests, ~1s
npm run test:watch
npm run test:coverage
npm run ci            # exactly what CI runs: typecheck + test + build
```

The suite runs the real application code — ingest, research, budgeting, routing,
archiving, the HTTP API — with no model calls and no network.

Two properties keep it honest:

- **Every test file gets a throwaway database.** `tests/setup.ts` repoints
  `LEADMAN_DB` at a temp file before any app module is imported, so tests can
  never read or write `data/leadman.db`.
- **The network is stubbed globally and fails loudly.** An unstubbed `fetch`
  throws with the URL it tried to reach, so an accidental live API call breaks the
  build rather than the bill. `.env` is not loaded under test either, so the suite
  behaves the same locally and in CI.

## CI

`.github/workflows/ci.yml` runs on every pull request and on pushes to `master`:

- **Test** on Node 22 and 24 — typecheck, test, build. No secrets required.
- **Hygiene** — fails the build if `.env` or a database file gets committed, or if
  a live-looking API key appears in the source.

In-flight runs are cancelled when a PR gets a new push.

## Notes and limits

- **Verify before you act on a lead.** Findings carry a confidence score and a
  source link for a reason. The model reads real pages and quotes them, but a
  mis-transcribed bid date is exactly the sort of error that looks fine.
- PDFs are text-extracted into the archive (council agendas are almost always
  PDFs — a Baton Rouge Metro Council agenda archives at ~55k characters). Scanned,
  image-only PDFs have no text layer and are recorded as such; there is no OCR.
- **Discovered source URLs are link-checked** before being activated. The model is
  asked to verify each URL and mostly does, but in testing 1 in 10 was a 404 — so
  every proposed URL gets a plain HTTP check, and anything that fails goes to the
  approval queue instead of being scanned.
- Contact research is limited to professional contact details an organization has
  published itself.
- Nothing is exposed to the network — the server binds locally and there is no
  authentication. Don't put it on a public interface as-is.
