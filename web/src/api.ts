export interface Profile {
  id: string;
  name: string;
  description: string;
  center_label: string;
  center_lat: number;
  center_lng: number;
  radius_miles: number;
  keywords: string[];
  jurisdictions: string[];
  active: boolean;
  last_assessed_at: string | null;
  created_at: string;
  stats: { activeSources: number; totalSources: number; discovered: number; tracked: number };
}

export interface WorkType {
  id: string;
  profile_id: string;
  key: string;
  name: string;
  description: string;
  active: boolean;
  sort_order: number;
  keywords: string[];
  lead_signals: string[];
  source_strategy: string;
  exclusions: string;
  planned_at: string | null;
  stats: { activeSources: number; projects: number };
}

export interface Source {
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
  workTypes?: { id: string; key: string; name: string }[];
}

export interface Project {
  id: string;
  profile_id: string;
  work_type_id: string | null;
  work_type_name?: string | null;
  work_type_key?: string | null;
  name: string;
  status: 'discovered' | 'tracked' | 'archived' | 'rejected';
  summary: string;
  project_type: string;
  stage: string;
  address: string;
  jurisdiction: string;
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
  source_count?: number;
  fact_count?: number;
  last_update_at?: string | null;
  update_summary?: string;
  update_kind?: string;
  update_at?: string;
}

export interface Fact {
  id: string;
  category: string;
  label: string;
  value: string;
  detail: string;
  source_url: string;
  artifact_id: string | null;
  confidence: number;
  found_at: string;
  superseded: number;
}

export interface ProjectSource {
  id: string;
  url: string;
  title: string;
  excerpt: string;
  kind: string;
  found_at: string;
  source_name: string | null;
  source_kind: string | null;
  artifact_id: string | null;
}

export interface ProjectUpdate {
  id: string;
  project_id: string;
  kind: string;
  summary: string;
  detail: string;
  created_at: string;
  project_name?: string;
  project_status?: string;
}

export interface Artifact {
  id: string;
  url: string;
  title: string;
  byte_size: number;
  fetched_at: string;
  text_length?: number;
  content_text?: string;
}

export interface Run {
  id: string;
  kind: string;
  trigger: string;
  status: string;
  label: string;
  summary: string;
  error: string;
  cost_usd: number;
  started_at: string;
  finished_at: string | null;
}

export interface Budget {
  month: string;
  monthlyCapUsd: number;
  monthToDateUsd: number;
  remainingUsd: number;
  perRunCapUsd: number;
  exhausted: boolean;
  daily?: { day: string; cost: number; calls: number }[];
  byPurpose?: { purpose: string; cost: number; calls: number }[];
}

export interface Dashboard {
  newlyDiscovered: Project[];
  recentlyUpdated: Project[];
  activity: ProjectUpdate[];
  counts: { discovered: number; tracked: number; archived: number; rejected: number; total: number };
  sourceCounts: { active: number; candidate: number; paused: number; dead: number; total: number };
  runs: Run[];
  budget: Budget;
  schedulerRunning: boolean;
  schedulerEnabled: boolean;
  apiKeyConfigured: boolean;
  credentials: {
    state: 'unchecked' | 'ok' | 'missing' | 'invalid' | 'unreachable';
    detail: string;
    shadowedEnvVars: string[];
  };
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = typeof body.error === 'string' ? body.error : JSON.stringify(body.error);
    } catch {
      /* keep status text */
    }
    throw new Error(message);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  dashboard: (profileId?: string) =>
    req<Dashboard>(`/dashboard${profileId ? `?profileId=${profileId}` : ''}`),

  profiles: () => req<Profile[]>('/profiles'),
  createProfile: (body: unknown) => req<Profile>('/profiles', { method: 'POST', body: JSON.stringify(body) }),
  updateProfile: (id: string, body: unknown) =>
    req<Profile>(`/profiles/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteProfile: (id: string) => req<void>(`/profiles/${id}`, { method: 'DELETE' }),
  discover: (id: string) => req<{ status: string; error: string }>(`/profiles/${id}/discover`, { method: 'POST' }),
  assess: (id: string) => req<{ status: string; error: string }>(`/profiles/${id}/assess`, { method: 'POST' }),

  sources: (profileId?: string) =>
    req<Source[]>(`/sources${profileId ? `?profileId=${profileId}` : ''}`),
  createSource: (body: unknown) => req<Source>('/sources', { method: 'POST', body: JSON.stringify(body) }),
  updateSource: (id: string, body: unknown) =>
    req<Source>(`/sources/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteSource: (id: string) => req<void>(`/sources/${id}`, { method: 'DELETE' }),
  scanSource: (id: string) => req<{ status: string; error: string }>(`/sources/${id}/scan`, { method: 'POST' }),

  projects: (params: { profileId?: string; status?: string; q?: string; workTypeId?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.profileId) qs.set('profileId', params.profileId);
    if (params.status) qs.set('status', params.status);
    if (params.q) qs.set('q', params.q);
    if (params.workTypeId) qs.set('workTypeId', params.workTypeId);
    const s = qs.toString();
    return req<Project[]>(`/projects${s ? `?${s}` : ''}`);
  },
  project: (id: string) =>
    req<{
      project: Project;
      sources: ProjectSource[];
      facts: Fact[];
      history: Fact[];
      updates: ProjectUpdate[];
      artifacts: Artifact[];
      workTypes: { id: string; key: string; name: string }[];
    }>(`/projects/${id}`),
  updateProject: (id: string, body: unknown) =>
    req<Project>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteProject: (id: string) => req<void>(`/projects/${id}`, { method: 'DELETE' }),
  research: (id: string) => req<{ status: string; error: string }>(`/projects/${id}/research`, { method: 'POST' }),
  artifact: (id: string) => req<Artifact>(`/projects/artifacts/${id}`),

  workTypes: (profileId: string) => req<WorkType[]>(`/work-types?profileId=${profileId}`),
  createWorkType: (body: unknown) =>
    req<WorkType>('/work-types', { method: 'POST', body: JSON.stringify(body) }),
  updateWorkType: (id: string, body: unknown) =>
    req<WorkType>(`/work-types/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteWorkType: (id: string) => req<void>(`/work-types/${id}`, { method: 'DELETE' }),
  planWorkType: (id: string) =>
    req<{ status: string; error: string }>(`/work-types/${id}/plan`, { method: 'POST' }),
  discoverForWorkType: (id: string) =>
    req<{ status: string; error: string }>(`/work-types/${id}/discover`, { method: 'POST' }),

  settings: () => req<{ settings: Record<string, string>; defaults: Record<string, string> }>('/settings'),
  saveSettings: (body: Record<string, string>) =>
    req<{ settings: Record<string, string> }>('/settings', { method: 'PUT', body: JSON.stringify(body) }),

  budget: () => req<Budget>('/budget'),
  runs: () => req<Run[]>('/runs'),
  run: (id: string) => req<{ run: Run; usage: unknown[] }>(`/runs/${id}`),
  tick: () => req<{ status?: string; skipped?: string }>('/tick', { method: 'POST' }),

  geocode: (q: string) =>
    req<{ label: string; lat: number; lng: number; type: string }[]>(
      `/geo/search?q=${encodeURIComponent(q)}`,
    ),
};
