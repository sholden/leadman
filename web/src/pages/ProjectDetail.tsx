import React from 'react';
import { api, type Artifact, type Fact } from '../api';
import { Badge, ErrorNote, Modal, StatusBadge, timeAgo, useAsync } from '../components/ui';

const CATEGORY_LABEL: Record<string, string> = {
  timeline: 'Timeline',
  budget: 'Budget',
  company: 'Companies involved',
  contact: 'Contacts',
  milestone: 'Milestones',
  detail: 'Project details',
};
const CATEGORY_ORDER = ['timeline', 'budget', 'company', 'contact', 'milestone', 'detail'];

export function ProjectDetail({ id, nav }: { id: string; nav: (hash: string) => void }) {
  const { data, error, loading, reload } = useAsync(() => api.project(id), [id]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const [viewing, setViewing] = React.useState<Artifact | null>(null);
  const [notes, setNotes] = React.useState<string | null>(null);

  if (loading && !data) return <div className="empty">Loading…</div>;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const { project, sources, facts, history, updates, artifacts, workTypes } = data;

  const setStatus = async (status: string) => {
    setBusy(status);
    setMsg(null);
    try {
      await api.updateProject(project.id, { status });
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const research = async () => {
    setBusy('research');
    setMsg(null);
    try {
      const r = await api.research(project.id);
      setMsg(
        r.status === 'ok'
          ? 'Research pass finished.'
          : r.status === 'budget_stopped'
            ? `Stopped: ${r.error}`
            : `Failed: ${r.error}`,
      );
      reload();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const byCategory = CATEGORY_ORDER.map((c) => ({
    category: c,
    items: facts.filter((f) => f.category === c),
  })).filter((g) => g.items.length > 0);

  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <a href="#/projects" className="tiny">
            ← All projects
          </a>
          <h1 style={{ marginTop: 6 }}>{project.name}</h1>
          <div className="inline">
            <StatusBadge status={project.status} />
            {project.work_type_name ? (
              <Badge tone="accent">{project.work_type_name}</Badge>
            ) : (
              workTypes.length > 0 && <Badge tone="warn">unclassified</Badge>
            )}
            <Badge tone={project.relevance >= 70 ? 'ok' : 'warn'}>{project.relevance}% fit</Badge>
            <Badge>{project.confidence}% confidence</Badge>
            {project.project_type && <Badge>{project.project_type}</Badge>}
            {project.stage && <Badge tone="accent">{project.stage}</Badge>}
          </div>
        </div>
        <div className="inline">
          {project.status === 'discovered' && (
            <>
              <button className="primary" disabled={!!busy} onClick={() => setStatus('tracked')}>
                Track this project
              </button>
              <button disabled={!!busy} onClick={() => setStatus('rejected')}>
                Not for us
              </button>
            </>
          )}
          {project.status === 'tracked' && (
            <>
              <button className="primary" disabled={!!busy} onClick={research}>
                {busy === 'research' ? 'Researching…' : 'Research now'}
              </button>
              <button disabled={!!busy} onClick={() => setStatus('archived')}>
                Archive
              </button>
            </>
          )}
          {(project.status === 'archived' || project.status === 'rejected') && (
            <button disabled={!!busy} onClick={() => setStatus('tracked')}>
              Re-track
            </button>
          )}
        </div>
      </div>

      {msg && <div className="banner info">{msg}</div>}
      {project.status === 'discovered' && (
        <div className="banner info">
          This lead was found automatically and hasn't been researched yet. Track it and the system
          will go looking for the timeline, budget, firms already involved, and who to call.
        </div>
      )}

      <div className="grid two">
        <div>
          <div className="card">
            <h2>Summary</h2>
            <p className="small" style={{ marginTop: 0 }}>
              {project.summary || <span className="muted">No summary recorded.</span>}
            </p>
            {workTypes.length > 0 && (
              <div className="field" style={{ marginTop: 12, marginBottom: 0 }}>
                <label htmlFor="project-work-type">Work type</label>
                <select
                  id="project-work-type"
                  value={project.work_type_id ?? ''}
                  onChange={async (e) => {
                    await api.updateProject(project.id, {
                      work_type_id: e.target.value || null,
                    });
                    reload();
                  }}
                >
                  <option value="">— unclassified —</option>
                  {workTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <div className="hint">
                  Set by the scan. Correct it here if it landed in the wrong bucket.
                </div>
              </div>
            )}

            <table style={{ marginTop: 10 }}>
              <tbody>
                <Row label="Owner" value={project.owner_org} />
                <Row label="Jurisdiction" value={project.jurisdiction} />
                <Row label="Address" value={project.address} />
                <Row label="Estimated value" value={project.estimated_value} />
                <Row label="Timeline" value={project.timeline_note} />
                <Row label="First seen" value={timeAgo(project.first_seen_at)} />
                <Row label="Last researched" value={timeAgo(project.last_researched_at)} />
              </tbody>
            </table>
          </div>

          {byCategory.length > 0 ? (
            byCategory.map((group) => (
              <div className="card" key={group.category}>
                <h2>
                  {CATEGORY_LABEL[group.category] ?? group.category}{' '}
                  <span className="count">({group.items.length})</span>
                </h2>
                <table>
                  <tbody>
                    {group.items.map((f) => (
                      <FactRow key={f.id} fact={f} onArtifact={setViewing} />
                    ))}
                  </tbody>
                </table>
              </div>
            ))
          ) : (
            <div className="card">
              <h2>Research findings</h2>
              <div className="empty">
                {project.status === 'tracked'
                  ? 'No findings yet — the next research pass will fill this in.'
                  : 'Track this project to start collecting findings.'}
              </div>
            </div>
          )}

          {history.length > 0 && (
            <div className="card">
              <h2>
                Superseded facts <span className="count">({history.length})</span>
              </h2>
              <p className="tiny muted" style={{ marginTop: -6 }}>
                Values that changed. Kept so you can see how the project moved.
              </p>
              <table>
                <tbody>
                  {history.map((f) => (
                    <tr key={f.id}>
                      <td className="tiny muted" style={{ width: 150 }}>
                        {CATEGORY_LABEL[f.category] ?? f.category} · {timeAgo(f.found_at)}
                      </td>
                      <td className="small" style={{ textDecoration: 'line-through', opacity: 0.7 }}>
                        <strong>{f.label}:</strong> {f.value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <div className="card">
            <h2>
              Sources &amp; archive <span className="count">({sources.length})</span>
            </h2>
            <p className="tiny muted" style={{ marginTop: -6 }}>
              Every page this project was mentioned on. A snapshot of each is stored locally, so
              the evidence survives the original page changing.
            </p>
            <div className="stack">
              {sources.map((s) => (
                <div className="item" key={s.id}>
                  <div className="inline">
                    <span className="small" style={{ fontWeight: 600 }}>
                      {s.title || s.source_name || 'Untitled document'}
                    </span>
                    <div className="spacer" />
                    <Badge tone={s.kind === 'origin' ? 'accent' : 'neutral'}>
                      {s.kind === 'origin' ? 'found here' : 'research'}
                    </Badge>
                  </div>
                  <div className="meta">
                    {s.source_name && <span>{s.source_name}</span>}
                    <span>{timeAgo(s.found_at)}</span>
                  </div>
                  {s.excerpt && <div className="body tiny">“{s.excerpt.slice(0, 260)}”</div>}
                  <div className="inline" style={{ marginTop: 8 }}>
                    <a
                      className="btn small"
                      href={s.url}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Open original
                    </a>
                    {s.artifact_id && (
                      <button
                        className="small"
                        onClick={async () => setViewing(await api.artifact(s.artifact_id!))}
                      >
                        View archived copy
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {sources.length === 0 && <div className="empty">No sources recorded.</div>}
            </div>
          </div>

          <div className="card">
            <h2>Your notes</h2>
            <textarea
              rows={5}
              value={notes ?? project.notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Called the facilities director 3/4 — RFQ expected in May."
            />
            <div className="inline" style={{ marginTop: 8 }}>
              <div className="spacer" />
              <button
                className="small"
                disabled={notes === null || notes === project.notes}
                onClick={async () => {
                  await api.updateProject(project.id, { notes });
                  setNotes(null);
                  reload();
                }}
              >
                Save notes
              </button>
            </div>
          </div>

          <div className="card">
            <h2>History</h2>
            <table>
              <tbody>
                {updates.map((u) => (
                  <tr key={u.id}>
                    <td className="tiny muted" style={{ width: 90 }}>
                      {timeAgo(u.created_at)}
                    </td>
                    <td className="small">
                      {u.summary}
                      {u.detail && (
                        <details>
                          <summary className="tiny muted" style={{ cursor: 'pointer' }}>
                            details
                          </summary>
                          <div className="tiny" style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>
                            {u.detail}
                          </div>
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
                {updates.length === 0 && (
                  <tr>
                    <td className="empty">Nothing yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h2>
              Archived documents <span className="count">({artifacts.length})</span>
            </h2>
            <div className="stack">
              {artifacts.map((a) => (
                <div className="inline" key={a.id}>
                  <button
                    className="small"
                    onClick={async () => setViewing(await api.artifact(a.id))}
                  >
                    View
                  </button>
                  <span className="tiny" style={{ minWidth: 0, overflow: 'hidden' }}>
                    {a.title || a.url}
                  </span>
                  <div className="spacer" />
                  <span className="tiny muted">{timeAgo(a.fetched_at)}</span>
                </div>
              ))}
              {artifacts.length === 0 && <div className="empty">Nothing archived yet.</div>}
            </div>
          </div>

          <div className="card">
            <button
              className="danger small"
              onClick={async () => {
                if (!confirm('Delete this project and its archive permanently?')) return;
                await api.deleteProject(project.id);
                nav('#/projects');
              }}
            >
              Delete project
            </button>
          </div>
        </div>
      </div>

      {viewing && (
        <Modal title={viewing.title || viewing.url} onClose={() => setViewing(null)} wide>
          <div className="inline" style={{ marginBottom: 10 }}>
            <a className="mono tiny" href={viewing.url} target="_blank" rel="noreferrer noopener">
              {viewing.url}
            </a>
            <div className="spacer" />
            <span className="tiny muted">archived {timeAgo(viewing.fetched_at)}</span>
          </div>
          <pre className="archive">{viewing.content_text}</pre>
        </Modal>
      )}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <tr>
      <th style={{ width: 130, borderBottom: 'none', paddingTop: 8 }}>{label}</th>
      <td style={{ borderBottom: 'none' }}>{value}</td>
    </tr>
  );
}

function FactRow({ fact, onArtifact }: { fact: Fact; onArtifact: (a: Artifact) => void }) {
  return (
    <tr>
      <td style={{ width: 190 }}>
        <strong className="small">{fact.label}</strong>
        {fact.confidence < 70 && (
          <div>
            <Badge tone="warn">{fact.confidence}% confident</Badge>
          </div>
        )}
      </td>
      <td>
        <div className="small">{fact.value}</div>
        {fact.detail && <div className="tiny muted">{fact.detail}</div>}
        <div className="inline" style={{ marginTop: 4 }}>
          {fact.source_url && (
            <a className="tiny" href={fact.source_url} target="_blank" rel="noreferrer noopener">
              source
            </a>
          )}
          {fact.artifact_id && (
            <button
              className="small"
              style={{ padding: '1px 7px', fontSize: 11.5 }}
              onClick={async () => onArtifact(await api.artifact(fact.artifact_id!))}
            >
              archived copy
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
