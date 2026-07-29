-- The database schema as it stood immediately before accounts were added,
-- captured from commit f6ad63f ("Pin Node for local shells too, via mise.toml").
--
-- Vendored rather than read from git at test time: CI checks out shallow, so
-- `git show` on a historical commit is not available there. This is a frozen
-- snapshot by definition, so a copy cannot drift from what it documents.
-- Do not edit. It describes the past, not the current schema.

-- Leadman schema. All timestamps are ISO-8601 UTC strings.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Single-holder leases over background work. Exists because a rolling deploy
-- briefly runs two containers against this same database file.
CREATE TABLE IF NOT EXISTS leases (
  key         TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- A "search profile" is one standing description of the work the firm wants,
-- plus the geography to look in.
CREATE TABLE IF NOT EXISTS profiles (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL,
  center_label   TEXT NOT NULL,
  center_lat     REAL NOT NULL,
  center_lng     REAL NOT NULL,
  radius_miles   REAL NOT NULL DEFAULT 50,
  -- AI-derived, refreshed on assessment
  keywords       TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
  jurisdictions  TEXT NOT NULL DEFAULT '[]',   -- JSON string[] of cities/parishes/counties in radius
  active         INTEGER NOT NULL DEFAULT 1,
  last_assessed_at TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- The kinds of work the firm actually chases. A firm that does school roofing and
-- a firm that follows a car-wash chain's expansion look for completely different
-- signals in completely different places, so this drives both where we hunt for
-- sources and what counts as a lead.
CREATE TABLE IF NOT EXISTS work_types (
  id           TEXT PRIMARY KEY,
  profile_id   TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,          -- stable slug the model references, e.g. "school-roofing"
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  -- AI-derived from the description, refreshed when it changes
  keywords         TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
  source_strategy  TEXT NOT NULL DEFAULT '',    -- where leads of this kind surface
  lead_signals     TEXT NOT NULL DEFAULT '[]',  -- JSON string[]: earliest observable signals
  exclusions       TEXT NOT NULL DEFAULT '',    -- what looks similar but doesn't count
  planned_at   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (profile_id, key)
);
CREATE INDEX IF NOT EXISTS idx_work_types_profile ON work_types (profile_id, active, sort_order);

-- Where leads come from: agenda pages, RFP portals, bid boards, permit feeds, news.
CREATE TABLE IF NOT EXISTS sources (
  id            TEXT PRIMARY KEY,
  profile_id    TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  url           TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'other',  -- meeting_minutes|rfp_portal|bid_board|permits|capital_plan|news|association|other
  jurisdiction  TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  discovery_reason TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'candidate', -- candidate|active|paused|dead
  origin        TEXT NOT NULL DEFAULT 'ai',        -- ai|manual
  score         REAL NOT NULL DEFAULT 50,          -- 0-100 running usefulness score
  scan_interval_hours REAL NOT NULL DEFAULT 24,
  consecutive_empty_scans INTEGER NOT NULL DEFAULT 0,
  total_scans   INTEGER NOT NULL DEFAULT 0,
  total_projects_found INTEGER NOT NULL DEFAULT 0,
  last_scanned_at TEXT,
  last_found_at   TEXT,
  next_scan_at    TEXT,
  last_error      TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (profile_id, url)
);
CREATE INDEX IF NOT EXISTS idx_sources_due ON sources (status, next_scan_at);

-- One source can serve several specializations (a school board agenda carries both
-- roofing work and new construction), so this is many-to-many.
CREATE TABLE IF NOT EXISTS source_work_types (
  source_id    TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  work_type_id TEXT NOT NULL REFERENCES work_types(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, work_type_id)
);
CREATE INDEX IF NOT EXISTS idx_swt_work_type ON source_work_types (work_type_id);

-- One row per unit of AI work. Declared before its referrers so foreign keys
-- resolve cleanly on a fresh database.
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  profile_id  TEXT REFERENCES profiles(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,  -- tick|discovery|assessment|scan|research
  trigger     TEXT NOT NULL DEFAULT 'schedule', -- schedule|manual
  status      TEXT NOT NULL DEFAULT 'running',  -- running|ok|error|budget_stopped
  label       TEXT NOT NULL DEFAULT '',
  summary     TEXT NOT NULL DEFAULT '',
  error       TEXT NOT NULL DEFAULT '',
  cost_usd    REAL NOT NULL DEFAULT 0,
  -- What the run is doing right now; cleared when it finishes.
  current_step    TEXT NOT NULL DEFAULT '',
  -- What it produced, for the activity view.
  sources_added   INTEGER NOT NULL DEFAULT 0,
  sources_scanned INTEGER NOT NULL DEFAULT 0,
  projects_found  INTEGER NOT NULL DEFAULT 0,
  facts_added     INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at DESC);

-- One row per attempt to scan a source.
CREATE TABLE IF NOT EXISTS source_scans (
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  run_id       TEXT REFERENCES runs(id) ON DELETE SET NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'running', -- running|ok|error|skipped
  candidates_found INTEGER NOT NULL DEFAULT 0,
  new_projects INTEGER NOT NULL DEFAULT 0,
  matched_projects INTEGER NOT NULL DEFAULT 0,
  notes        TEXT NOT NULL DEFAULT '',
  cost_usd     REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_source_scans_source ON source_scans (source_id, started_at DESC);

-- The thing we actually care about.
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  profile_id    TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  work_type_id  TEXT REFERENCES work_types(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  match_key     TEXT NOT NULL DEFAULT '',   -- normalized name, for cheap dedupe
  status        TEXT NOT NULL DEFAULT 'discovered', -- discovered|tracked|archived|rejected
  summary       TEXT NOT NULL DEFAULT '',
  project_type  TEXT NOT NULL DEFAULT '',
  stage         TEXT NOT NULL DEFAULT '',   -- e.g. planning, design, RFQ issued, bidding, under construction
  address       TEXT NOT NULL DEFAULT '',
  jurisdiction  TEXT NOT NULL DEFAULT '',
  lat           REAL,
  lng           REAL,
  distance_miles REAL,
  owner_org     TEXT NOT NULL DEFAULT '',
  estimated_value TEXT NOT NULL DEFAULT '',
  timeline_note TEXT NOT NULL DEFAULT '',
  relevance     INTEGER NOT NULL DEFAULT 50,  -- 0-100, AI's fit-to-profile judgement
  confidence    INTEGER NOT NULL DEFAULT 50,  -- 0-100, how sure we are it's real
  notes         TEXT NOT NULL DEFAULT '',     -- user's own notes
  first_seen_at TEXT NOT NULL,
  last_updated_at TEXT NOT NULL,
  tracked_at    TEXT,
  last_researched_at TEXT,
  research_interval_hours REAL NOT NULL DEFAULT 72,
  next_research_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_projects_profile_status ON projects (profile_id, status);
CREATE INDEX IF NOT EXISTS idx_projects_match ON projects (profile_id, match_key);

-- Many sources can point at the same project. This is that link, plus every
-- other document we later find while researching it.
CREATE TABLE IF NOT EXISTS project_sources (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id   TEXT REFERENCES sources(id) ON DELETE SET NULL, -- null when found by research
  url         TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  excerpt     TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'origin', -- origin|research
  found_at    TEXT NOT NULL,
  UNIQUE (project_id, url)
);
CREATE INDEX IF NOT EXISTS idx_project_sources_project ON project_sources (project_id);

-- Archived copy of every document we based a finding on.
CREATE TABLE IF NOT EXISTS artifacts (
  id                TEXT PRIMARY KEY,
  project_id        TEXT REFERENCES projects(id) ON DELETE CASCADE,
  project_source_id TEXT REFERENCES project_sources(id) ON DELETE SET NULL,
  source_id         TEXT REFERENCES sources(id) ON DELETE SET NULL,
  url               TEXT NOT NULL,
  title             TEXT NOT NULL DEFAULT '',
  content_text      TEXT NOT NULL DEFAULT '',
  content_hash      TEXT NOT NULL DEFAULT '',
  byte_size         INTEGER NOT NULL DEFAULT 0,
  fetched_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts (project_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_hash ON artifacts (content_hash);

-- Structured research findings about a tracked project.
CREATE TABLE IF NOT EXISTS project_facts (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category     TEXT NOT NULL,  -- timeline|budget|company|contact|detail|milestone
  label        TEXT NOT NULL,
  value        TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  source_url   TEXT NOT NULL DEFAULT '',
  artifact_id  TEXT REFERENCES artifacts(id) ON DELETE SET NULL,
  confidence   INTEGER NOT NULL DEFAULT 50,
  fact_key     TEXT NOT NULL DEFAULT '',  -- category+normalized label, for supersede
  superseded   INTEGER NOT NULL DEFAULT 0,
  found_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_project ON project_facts (project_id, superseded, category);

-- Dashboard feed: "what changed recently".
CREATE TABLE IF NOT EXISTS project_updates (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id     TEXT REFERENCES runs(id) ON DELETE SET NULL,
  kind       TEXT NOT NULL, -- discovered|new_source|new_facts|status_change|stage_change|research_error
  summary    TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  seen       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_updates_created ON project_updates (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_updates_project ON project_updates (project_id, created_at DESC);

-- Timestamped log of what a run did, written as it happens rather than at the end,
-- so in-progress work is visible while it is still running.
CREATE TABLE IF NOT EXISTS run_events (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  at         TEXT NOT NULL,
  level      TEXT NOT NULL DEFAULT 'info',  -- info|result|warn|error
  message    TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  source_id     TEXT,
  project_id    TEXT,
  work_type_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events (run_id, seq);
CREATE INDEX IF NOT EXISTS idx_run_events_at ON run_events (at DESC);

-- Every model call, for the budget guard and the spend display.
CREATE TABLE IF NOT EXISTS usage_ledger (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT REFERENCES runs(id) ON DELETE SET NULL,
  purpose             TEXT NOT NULL DEFAULT '',
  model               TEXT NOT NULL,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  web_search_requests INTEGER NOT NULL DEFAULT 0,
  cost_usd            REAL NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  month_key           TEXT NOT NULL  -- YYYY-MM in local time, for the monthly cap
);
CREATE INDEX IF NOT EXISTS idx_usage_month ON usage_ledger (month_key);
CREATE INDEX IF NOT EXISTS idx_usage_run ON usage_ledger (run_id);
