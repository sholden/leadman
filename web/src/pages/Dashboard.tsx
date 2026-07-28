import React from 'react';
import { api, type Dashboard as DashboardData } from '../api';
import { Badge, ErrorNote, StatusBadge, money, timeAgo, useAsync } from '../components/ui';

export function Dashboard({ profileId, nav }: { profileId: string; nav: (hash: string) => void }) {
  const { data, error, loading, reload } = useAsync<DashboardData>(
    () => api.dashboard(profileId || undefined),
    [profileId],
  );
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);

  // Refresh while a pass is running so progress shows up on its own.
  React.useEffect(() => {
    if (!data?.schedulerRunning) return;
    const t = setInterval(reload, 8000);
    return () => clearInterval(t);
  }, [data?.schedulerRunning, reload]);

  async function runNow() {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.tick();
      setNote(
        r.skipped === 'budget'
          ? 'Skipped: the monthly budget is used up. Raise it in Settings to continue.'
          : r.skipped === 'already running'
            ? 'A pass is already running.'
            : 'Pass finished.',
      );
      reload();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <div className="empty">Loading…</div>;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const b = data.budget;
  const pct = b.monthlyCapUsd > 0 ? Math.min(100, (b.monthToDateUsd / b.monthlyCapUsd) * 100) : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>
            New leads the system found on its own, and tracked projects where something changed.
          </p>
        </div>
        <div className="inline">
          <button onClick={reload}>Refresh</button>
          <button className="primary" onClick={runNow} disabled={busy || data.schedulerRunning}>
            {busy || data.schedulerRunning ? 'Running…' : 'Run a pass now'}
          </button>
        </div>
      </div>

      {data.credentials?.state !== 'ok' && data.credentials?.state !== 'unchecked' && (
        <div className="banner danger">
          <strong>
            {data.credentials.state === 'missing'
              ? 'No API key configured.'
              : data.credentials.state === 'invalid'
                ? 'The Anthropic API key was rejected.'
                : 'Cannot reach the Anthropic API.'}
          </strong>{' '}
          {data.credentials.detail} Nothing can be discovered, scanned, or researched until this is
          fixed. Update <code>.env</code> and restart.
        </div>
      )}
      {(data.credentials?.shadowedEnvVars?.length ?? 0) > 0 && (
        <div className="banner warn">
          <strong>{data.credentials.shadowedEnvVars.join(', ')}</strong> is set both in your shell
          and in <code>.env</code>, with different values — the shell value wins and{' '}
          <code>.env</code> is being ignored. Unset it in your shell, or put the right value there.
        </div>
      )}
      {b.exhausted && (
        <div className="banner warn">
          Monthly budget of {money(b.monthlyCapUsd)} is used up ({money(b.monthToDateUsd)} spent).
          All AI work is paused until next month or until you raise the cap in Settings.
        </div>
      )}
      {!data.schedulerEnabled && (
        <div className="banner info">
          The background scheduler is off (<code>LEADMAN_SCHEDULER=off</code>). Use “Run a pass now”.
        </div>
      )}
      {note && <div className="banner info">{note}</div>}

      <div className="grid stats" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="label">New leads</div>
          <div className="value">{data.counts?.discovered ?? 0}</div>
          <div className="sub">awaiting your call</div>
        </div>
        <div className="stat">
          <div className="label">Tracked</div>
          <div className="value">{data.counts?.tracked ?? 0}</div>
          <div className="sub">being researched</div>
        </div>
        <div className="stat">
          <div className="label">Active sources</div>
          <div className="value">{data.sourceCounts?.active ?? 0}</div>
          <div className="sub">
            {data.sourceCounts?.candidate ?? 0} awaiting approval · {data.sourceCounts?.paused ?? 0} paused
          </div>
        </div>
        <div className="stat">
          <div className="label">Spend this month</div>
          <div className="value">{money(b.monthToDateUsd)}</div>
          <div className={`meter${b.monthToDateUsd >= b.monthlyCapUsd ? ' over' : ''}`}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="sub">of {money(b.monthlyCapUsd)} cap</div>
        </div>
      </div>

      <div className="grid two">
        <div className="card">
          <h2>
            Newly discovered <span className="count">({data.newlyDiscovered.length})</span>
          </h2>
          {data.newlyDiscovered.length === 0 ? (
            <div className="empty">
              Nothing new yet. Run a pass, or add sources on the Sources page.
            </div>
          ) : (
            <div className="stack">
              {data.newlyDiscovered.map((p) => (
                <a key={p.id} className="item" href={`#/projects/${p.id}`}>
                  <div className="inline">
                    <span className="title">{p.name}</span>
                    <div className="spacer" />
                    <Badge tone={p.relevance >= 70 ? 'ok' : p.relevance >= 50 ? 'warn' : 'neutral'}>
                      {p.relevance}% fit
                    </Badge>
                  </div>
                  <div className="meta">
                    {p.project_type && <span>{p.project_type}</span>}
                    {p.jurisdiction && <span>{p.jurisdiction}</span>}
                    {p.estimated_value && <span>{p.estimated_value}</span>}
                    <span>found {timeAgo(p.first_seen_at)}</span>
                  </div>
                  {p.summary && <div className="body">{p.summary}</div>}
                </a>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <h2>
            Tracked projects with new information{' '}
            <span className="count">({data.recentlyUpdated.length})</span>
          </h2>
          {data.recentlyUpdated.length === 0 ? (
            <div className="empty">
              Nothing tracked yet. Open a discovered project and press “Track this project”.
            </div>
          ) : (
            <div className="stack">
              {data.recentlyUpdated.map((p) => (
                <a key={p.id} className="item" href={`#/projects/${p.id}`}>
                  <div className="inline">
                    <span className="title">{p.name}</span>
                    <div className="spacer" />
                    <span className="tiny muted">{timeAgo(p.update_at)}</span>
                  </div>
                  <div className="meta">
                    {p.stage && <span>{p.stage}</span>}
                    {p.jurisdiction && <span>{p.jurisdiction}</span>}
                    {p.estimated_value && <span>{p.estimated_value}</span>}
                  </div>
                  <div className="body">{p.update_summary}</div>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid two" style={{ marginTop: 14 }}>
        <div className="card">
          <h2>Recent activity</h2>
          {data.activity.length === 0 ? (
            <div className="empty">No activity yet.</div>
          ) : (
            <table>
              <tbody>
                {data.activity.slice(0, 18).map((u) => (
                  <tr key={u.id}>
                    <td style={{ width: 90 }} className="tiny muted">
                      {timeAgo(u.created_at)}
                    </td>
                    <td>
                      <a href={`#/projects/${u.project_id}`}>{u.project_name}</a>
                      <div className="tiny muted">{u.summary}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h2>Recent runs</h2>
          {data.runs.length === 0 ? (
            <div className="empty">No runs yet.</div>
          ) : (
            <table>
              <tbody>
                {data.runs.map((r) => (
                  <tr key={r.id}>
                    <td style={{ width: 90 }} className="tiny muted">
                      {timeAgo(r.started_at)}
                    </td>
                    <td>
                      <span className="small">
                        {r.kind}
                        {r.label ? ` · ${r.label}` : ''}
                      </span>
                      {r.error && <div className="tiny muted">{r.error}</div>}
                    </td>
                    <td style={{ width: 110, textAlign: 'right' }}>
                      <StatusBadge status={r.status} />
                      <div className="tiny muted">{money(r.cost_usd)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{ marginTop: 10 }}>
            <button className="small" onClick={() => nav('#/settings')}>
              Budget &amp; settings
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
