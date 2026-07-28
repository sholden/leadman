import React from 'react';
import { api, type Project, type WorkType } from '../api';
import { Badge, ErrorNote, StatusBadge, timeAgo, useAsync } from '../components/ui';

const TABS = [
  { key: 'discovered', label: 'New leads' },
  { key: 'tracked', label: 'Tracked' },
  { key: 'archived', label: 'Archived' },
  { key: 'rejected', label: 'Rejected' },
  { key: '', label: 'All' },
];

export function Projects({ profileId }: { profileId: string }) {
  const [status, setStatus] = React.useState('discovered');
  const [q, setQ] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [workTypeId, setWorkTypeId] = React.useState('');

  const { data, error, loading } = useAsync<Project[]>(
    () =>
      api.projects({
        profileId: profileId || undefined,
        status: status || undefined,
        q: search || undefined,
        workTypeId: workTypeId || undefined,
      }),
    [profileId, status, search, workTypeId],
  );

  // The filter only makes sense scoped to one profile's specializations.
  const workTypes = useAsync<WorkType[]>(
    () => (profileId ? api.workTypes(profileId) : Promise.resolve([])),
    [profileId],
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p>
            Everything found so far. Move a lead to <em>Tracked</em> and the system starts digging
            for its timeline, budget, involved firms, and contacts.
          </p>
        </div>
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(q);
          }}
        >
          {(workTypes.data?.length ?? 0) > 0 && (
            <select
              aria-label="Filter by work type"
              style={{ width: 210 }}
              value={workTypeId}
              onChange={(e) => setWorkTypeId(e.target.value)}
            >
              <option value="">All work types</option>
              {workTypes.data!.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
              <option value="none">Unclassified</option>
            </select>
          )}
          <input
            style={{ width: 220 }}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or place…"
          />
          <button className="shrink">Search</button>
        </form>
      </div>

      <ErrorNote error={error} />

      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={status === t.key ? 'active' : ''}
            onClick={() => setStatus(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && !data ? (
        <div className="empty">Loading…</div>
      ) : data?.length === 0 ? (
        <div className="empty">Nothing here.</div>
      ) : (
        <div className="stack">
          {data?.map((p) => (
            <a key={p.id} className="item" href={`#/projects/${p.id}`}>
              <div className="inline">
                <span className="title">{p.name}</span>
                {status === '' && <StatusBadge status={p.status} />}
                <div className="spacer" />
                <Badge tone={p.relevance >= 70 ? 'ok' : p.relevance >= 50 ? 'warn' : 'neutral'}>
                  {p.relevance}% fit
                </Badge>
              </div>
              <div className="meta">
                {p.work_type_name && <Badge tone="accent">{p.work_type_name}</Badge>}
                {p.project_type && <span>{p.project_type}</span>}
                {p.stage && <span>{p.stage}</span>}
                {p.jurisdiction && <span>{p.jurisdiction}</span>}
                {p.estimated_value && <span>{p.estimated_value}</span>}
                <span>
                  {p.source_count ?? 0} source{(p.source_count ?? 0) === 1 ? '' : 's'}
                </span>
                {(p.fact_count ?? 0) > 0 && <span>{p.fact_count} facts</span>}
                <span>found {timeAgo(p.first_seen_at)}</span>
              </div>
              {p.summary && <div className="body">{p.summary}</div>}
            </a>
          ))}
        </div>
      )}
    </>
  );
}
