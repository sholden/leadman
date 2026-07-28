/** Row shapes for the tables we read most often. */

export interface ProfileRow {
  id: string;
  name: string;
  description: string;
  center_label: string;
  center_lat: number;
  center_lng: number;
  radius_miles: number;
  keywords: string;
  jurisdictions: string;
  active: number;
  last_assessed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkTypeRow {
  id: string;
  profile_id: string;
  key: string;
  name: string;
  description: string;
  active: number;
  sort_order: number;
  keywords: string;
  source_strategy: string;
  lead_signals: string;
  exclusions: string;
  planned_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceRow {
  id: string;
  profile_id: string;
  name: string;
  url: string;
  kind: string;
  jurisdiction: string;
  description: string;
  discovery_reason: string;
  status: string;
  origin: string;
  score: number;
  scan_interval_hours: number;
  consecutive_empty_scans: number;
  total_scans: number;
  total_projects_found: number;
  last_scanned_at: string | null;
  last_found_at: string | null;
  next_scan_at: string | null;
  last_error: string;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  profile_id: string;
  work_type_id: string | null;
  name: string;
  match_key: string;
  status: string;
  summary: string;
  project_type: string;
  stage: string;
  address: string;
  jurisdiction: string;
  lat: number | null;
  lng: number | null;
  distance_miles: number | null;
  owner_org: string;
  estimated_value: string;
  timeline_note: string;
  relevance: number;
  confidence: number;
  notes: string;
  first_seen_at: string;
  last_updated_at: string;
  tracked_at: string | null;
  last_researched_at: string | null;
  research_interval_hours: number;
  next_research_at: string | null;
}

export const parseJsonArray = (raw: string): string[] => {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
