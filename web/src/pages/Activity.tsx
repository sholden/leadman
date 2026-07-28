import React from 'react';
import { api, type Activity as ActivityData, type Run, type RunEvent } from '../api';
import { Badge, ErrorNote, StatusBadge, money, timeAgo, useAsync } from '../components/ui';

const KIND_LABEL: Record<string, string> = {
  tick: 'Scheduled pass',
  discovery: 'Source hunt',
  assessment: 'Coverage review',
  scan: 'Source scan',
  research: 'Project research',
  plan: 'Work-type planning',
};

function duration(from: string, to: string | null): string {
  const ms = (to ? Date.parse(to) : Date.now()) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** The counters a run produced, rendered only when non-zero. */
function Outcomes({ run }: { run: Run }) {
  const parts: string[] = [];
  if (run.sources_added) parts.push(`${run.sources_added} source${run.sources_added === 1 ? '' : 's'} found`);
  if (run.sources_scanned) parts.push(`${run.sources_scanned} scanned`);
  if (run.projects_found) parts.push(`${run.projects_found} new lead${run.projects_found === 1 ? '' : 's'}`);
  if (run.facts_added) parts.push(`${run.facts_added} fact${run.facts_added === 1 ? '' : 's'}`);
  if (parts.length === 0) return <span className="tiny muted">no new results</span>;
  return (
    <span className="inline" style={{ gap: 5 }}>
      {parts.map((p) => (
        <Badge key={p} tone="ok">
          {p}
        </Badge>
      ))}
    </span>
  );
}

function EventLine({ e }: { e: RunEvent }) {
  const [open, setOpen] = React.useState(false);
  const tone =
    e.level === 'result' ? 'ok' : e.level === 'error' ? 'danger' : e.level === 'warn' ? 'warn' : 'neutral';
  return (
    <tr>
      <td className="tiny muted" style={{ width: 78, whiteSpace: 'nowrap' }}>
        {new Date(e.at).toLocaleTimeString()}
      </td>
      <td>
        <span className="small">
          {e.level === 'result' && <Badge tone={tone}>found</Badge>}{' '}
          {e.project_id ? (
            <a href={`#/projects/${e.project_id}`}>{e.message}</a>
          ) : (
            e.message
          )}
        </span>
        {e.detail && (
          <>
            {' '}
            <button
              className="small"
              style={{ padding: '0 6px', fontSize: 11 }}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? 'hide' : 'details'}
            </button>
            {open && (
              <pre className="archive" style={{ marginTop: 6, maxHeight: 220 }}>
                {e.detail}
              </pre>
            )}
          </>
        )}
      </td>
    </tr>
  );
}

function RunRow({ run }: { run: Run }) {
  const [open, setOpen] = React.useState(false);
  const detail = useAsync(
    () => (open ? api.runDetail(run.id) : Promise.resolve(null)),
    [open, run.id],
  );

  return (
    <>
      <tr>
        <td style={{ width: 92 }} className="tiny muted">
          {timeAgo(run.started_at)}
        </td>
        <td>
          <span className="small" style={{ fontWeight: 600 }}>
            {KIND_LABEL[run.kind] ?? run.kind}
          </span>
          {run.label && <span className="small muted"> · {run.label}</span>}
          {run.trigger === 'manual' && (
            <>
              {' '}
              <Badge>manual</Badge>
            </>
          )}
          <div style={{ marginTop: 4 }}>
            <Outcomes run={run} />
          </div>
          {run.error && <div className="tiny" style={{ color: 'var(--danger)' }}>{run.error}</div>}
        </td>
        <td className="tiny muted" style={{ width: 72 }}>
          {duration(run.started_at, run.finished_at)}
        </td>
        <td style={{ width: 96, textAlign: 'right' }}>
          <StatusBadge status={run.status} />
          <div className="tiny muted">{money(run.cost_usd)}</div>
        </td>
        <td style={{ width: 70, textAlign: 'right' }}>
          <button className="small" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : 'Timeline'}
          </button>
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ background: 'var(--bg)' }}>
            {detail.loading && <div className="tiny muted">Loading timeline…</div>}
            {detail.data && (
              <>
                <table>
                  <tbody>
                    {detail.data.events.map((e) => (
                      <EventLine key={e.id} e={e} />
                    ))}
                    {detail.data.events.length === 0 && (
                      <tr>
                        <td className="tiny muted">
                          No timeline recorded — this run predates event logging.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                {detail.data.usage.length > 0 && (
                  <div className="tiny muted" style={{ marginTop: 8 }}>
                    {detail.data.usage.length} model call
                    {detail.data.usage.length === 1 ? '' : 's'} ·{' '}
                    {detail.data.usage
                      .map((u) => `${(u as { purpose: string }).purpose}`)
                      .filter((v, i, a) => a.indexOf(v) === i)
                      .join(', ')}
                  </div>
                )}
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function ActivityPage() {
  const { data, error, loading, reload } = useAsync<ActivityData>(() => api.activity(), []);

  // Poll while something is running so progress appears without a manual refresh.
  React.useEffect(() => {
    if (!data?.active.length) return;
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [data?.active.length, reload]);

  if (loading && !data) return <div className="empty">Loading…</div>;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const t = data.totals;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <p>
            What the system is doing right now, and everything it has done — with what each pass
            actually produced.
          </p>
        </div>
        <button onClick={reload}>Refresh</button>
      </div>

      <div className="grid stats" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="label">Passes (7 days)</div>
          <div className="value">{t.runs ?? 0}</div>
          <div className="sub">{money(t.cost ?? 0)} spent</div>
        </div>
        <div className="stat">
          <div className="label">Sources found</div>
          <div className="value">{t.sources_added ?? 0}</div>
          <div className="sub">{t.sources_scanned ?? 0} scans run</div>
        </div>
        <div className="stat">
          <div className="label">Leads found</div>
          <div className="value">{t.projects_found ?? 0}</div>
          <div className="sub">in the last 7 days</div>
        </div>
        <div className="stat">
          <div className="label">Facts researched</div>
          <div className="value">{t.facts_added ?? 0}</div>
          <div className="sub">on tracked projects</div>
        </div>
      </div>

      <div className="card">
        <h2>
          Working now{' '}
          {data.active.length > 0 && <span className="count">({data.active.length})</span>}
        </h2>
        {data.active.length === 0 ? (
          <div className="empty">
            Nothing running. {data.schedulerRunning ? '' : 'The next scheduled pass will appear here.'}
          </div>
        ) : (
          <div className="stack">
            {data.active.map((run) => {
              const events = data.liveEvents.filter((e) => e.run_id === run.id).slice(-6);
              return (
                <div className="item" key={run.id}>
                  <div className="inline">
                    <span className="title">{KIND_LABEL[run.kind] ?? run.kind}</span>
                    {run.label && <span className="small muted">{run.label}</span>}
                    <div className="spacer" />
                    <span className="tiny muted">
                      running {duration(run.started_at, null)} · {money(run.cost_usd)}
                    </span>
                  </div>
                  {run.current_step && (
                    <div className="small" style={{ marginTop: 6 }}>
                      <span className="badge accent">now</span> {run.current_step}
                    </div>
                  )}
                  <div style={{ marginTop: 6 }}>
                    <Outcomes run={run} />
                  </div>
                  {events.length > 0 && (
                    <table style={{ marginTop: 8 }}>
                      <tbody>
                        {events.map((e) => (
                          <EventLine key={e.id} e={e} />
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="card">
        <h2>
          Past work <span className="count">({data.recent.length})</span>
        </h2>
        {data.recent.length === 0 ? (
          <div className="empty">Nothing has run yet.</div>
        ) : (
          <div className="scroll-x">
            <table>
              <tbody>
                {data.recent.map((run) => (
                  <RunRow key={run.id} run={run} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
