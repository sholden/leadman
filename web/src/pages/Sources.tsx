import React from 'react';
import { api, type Profile, type Source } from '../api';
import { Badge, ErrorNote, Field, Modal, StatusBadge, timeAgo, useAsync, whenNext } from '../components/ui';

const KINDS = [
  'meeting_minutes',
  'rfp_portal',
  'bid_board',
  'permits',
  'zoning',
  'capital_plan',
  'news',
  'corporate',
  'real_estate',
  'association',
  'other',
] as const;

const KIND_LABEL: Record<string, string> = {
  meeting_minutes: 'Agendas & minutes',
  rfp_portal: 'RFP portal',
  bid_board: 'Bid board',
  permits: 'Permits',
  zoning: 'Zoning & site plan',
  capital_plan: 'Capital plan',
  news: 'News & trade press',
  corporate: 'Corporate / franchise',
  real_estate: 'Real estate',
  association: 'Association',
  other: 'Other',
};

export function Sources({ profileId, profiles }: { profileId: string; profiles: Profile[] }) {
  const { data, error, loading, reload } = useAsync<Source[]>(
    () => api.sources(profileId || undefined),
    [profileId],
  );
  const [filter, setFilter] = React.useState('all');
  const [adding, setAdding] = React.useState(false);
  const [detail, setDetail] = React.useState<Source | null>(null);

  const sources = (data ?? []).filter((s) => filter === 'all' || s.status === filter);
  const byStatus = (s: string) => (data ?? []).filter((x) => x.status === s).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Lead sources</h1>
          <p>
            Pages the system watches for new projects. It finds these on its own and adjusts how
            often it checks each one based on what that source actually produces.
          </p>
        </div>
        <button
          className="primary"
          onClick={() => setAdding(true)}
          disabled={profiles.length === 0}
        >
          Add a source
        </button>
      </div>

      <ErrorNote error={error} />

      <div className="tabs">
        {[
          ['all', `All (${data?.length ?? 0})`],
          ['active', `Active (${byStatus('active')})`],
          ['candidate', `Awaiting approval (${byStatus('candidate')})`],
          ['paused', `Paused (${byStatus('paused')})`],
          ['dead', `Retired (${byStatus('dead')})`],
        ].map(([key, label]) => (
          <button
            key={key}
            className={filter === key ? 'active' : ''}
            onClick={() => setFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {byStatus('candidate') > 0 && filter === 'all' && (
        <div className="banner info">
          {byStatus('candidate')} source{byStatus('candidate') === 1 ? '' : 's'} the AI was less sure
          about are waiting for your approval. Review them and press Activate to start scanning.
        </div>
      )}

      {loading && !data ? (
        <div className="empty">Loading…</div>
      ) : sources.length === 0 ? (
        <div className="empty">
          No sources here yet. Use “Find sources now” on the Profiles page, or add one manually.
        </div>
      ) : (
        <div className="card scroll-x">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Type</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Yield</th>
                <th>Last scan</th>
                <th>Next</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{s.name}</div>
                    <a
                      className="tiny mono"
                      href={s.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {s.url.length > 68 ? `${s.url.slice(0, 68)}…` : s.url}
                    </a>
                    {s.jurisdiction && <div className="tiny muted">{s.jurisdiction}</div>}
                    {(s.workTypes?.length ?? 0) > 0 && (
                      <div className="inline" style={{ gap: 4, marginTop: 4 }}>
                        {s.workTypes!.map((t) => (
                          <Badge key={t.id} tone="accent">
                            {t.name}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="small">{KIND_LABEL[s.kind] ?? s.kind}</td>
                  <td>
                    <StatusBadge status={s.status} />
                    {s.origin === 'manual' && (
                      <div style={{ marginTop: 3 }}>
                        <Badge>manual</Badge>
                      </div>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }} className="small">
                    <strong>{s.total_projects_found}</strong>
                    <div className="tiny muted">in {s.total_scans} scans</div>
                  </td>
                  <td className="small muted">{timeAgo(s.last_scanned_at)}</td>
                  <td className="small muted">
                    {s.status === 'active' ? whenNext(s.next_scan_at) : '—'}
                    <div className="tiny muted">every {Math.round(s.scan_interval_hours)}h</div>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="small" onClick={() => setDetail(s)}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <AddSource
          profiles={profiles}
          defaultProfile={profileId || profiles[0]?.id}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
      {detail && (
        <SourceDetail
          source={detail}
          onClose={() => setDetail(null)}
          onChanged={() => {
            setDetail(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function AddSource({
  profiles,
  defaultProfile,
  onClose,
  onSaved,
}: {
  profiles: Profile[];
  defaultProfile?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState({
    profile_id: defaultProfile ?? '',
    name: '',
    url: '',
    kind: 'other',
    jurisdiction: '',
    description: '',
  });
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  return (
    <Modal title="Add a lead source" onClose={onClose}>
      <ErrorNote error={error} />
      <Field label="Profile">
        {(id) => (
          <select
            id={id}
            name="profile_id"
            value={form.profile_id}
            onChange={(e) => setForm({ ...form, profile_id: e.target.value })}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <div className="row">
        <Field label="Name" className="field" >
          {(id) => (
            <input
              id={id}
              name="name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="East Baton Rouge Parish School Board — Agendas"
            />
          )}
        </Field>
        <Field label="Type">
          {(id) => (
            <select
              id={id}
              name="kind"
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <Field
        label="URL"
        hint="Point at the listing or index page that gets new items over time, not a single document."
      >
        {(id) => (
          <input
            id={id}
            name="url"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            placeholder="https://…"
          />
        )}
      </Field>
      <div className="row">
        <Field label="Jurisdiction">
          {(id) => (
            <input
              id={id}
              name="jurisdiction"
              value={form.jurisdiction}
              onChange={(e) => setForm({ ...form, jurisdiction: e.target.value })}
              placeholder="East Baton Rouge Parish"
            />
          )}
        </Field>
      </div>
      <Field label="Notes for the AI (optional)">
        {(id) => (
          <textarea
            id={id}
            name="description"
            rows={3}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Posts board packets the Friday before each monthly meeting; capital items are in the consent agenda."
          />
        )}
      </Field>
      <div className="inline">
        <div className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button
          className="primary"
          disabled={busy || !form.name || !form.url || !form.profile_id}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.createSource(form);
              onSaved();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Adding…' : 'Add source'}
        </button>
      </div>
    </Modal>
  );
}

function SourceDetail({
  source,
  onClose,
  onChanged,
}: {
  source: Source;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<string | null>(null);

  const act = async (label: string, fn: () => Promise<unknown>, close = true) => {
    setBusy(label);
    setMsg(null);
    try {
      await fn();
      if (close) onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title={source.name} onClose={onClose} wide>
      {msg && <div className="banner danger">{msg}</div>}

      <div className="inline" style={{ marginBottom: 12 }}>
        <StatusBadge status={source.status} />
        <Badge>{KIND_LABEL[source.kind] ?? source.kind}</Badge>
        {source.jurisdiction && <Badge>{source.jurisdiction}</Badge>}
        <Badge tone={source.score >= 60 ? 'ok' : source.score >= 30 ? 'warn' : 'danger'}>
          score {Math.round(source.score)}
        </Badge>
      </div>

      <div className="field">
        <a href={source.url} target="_blank" rel="noreferrer noopener" className="mono">
          {source.url}
        </a>
      </div>

      {source.description && <p className="small">{source.description}</p>}
      {source.discovery_reason && (
        <p className="small muted">
          <strong>Why it was picked:</strong> {source.discovery_reason}
        </p>
      )}
      {source.last_error && <div className="banner warn">{source.last_error}</div>}

      <div className="grid stats" style={{ margin: '14px 0' }}>
        <div className="stat">
          <div className="label">Projects found</div>
          <div className="value">{source.total_projects_found}</div>
          <div className="sub">across {source.total_scans} scans</div>
        </div>
        <div className="stat">
          <div className="label">Empty streak</div>
          <div className="value">{source.consecutive_empty_scans}</div>
          <div className="sub">scans with nothing new</div>
        </div>
        <div className="stat">
          <div className="label">Checked every</div>
          <div className="value">{Math.round(source.scan_interval_hours)}h</div>
          <div className="sub">auto-tuned by yield</div>
        </div>
        <div className="stat">
          <div className="label">Last scan</div>
          <div className="value" style={{ fontSize: 17 }}>
            {timeAgo(source.last_scanned_at)}
          </div>
          <div className="sub">next {whenNext(source.next_scan_at)}</div>
        </div>
      </div>

      <div className="inline">
        {source.status !== 'active' && (
          <button
            className="primary"
            disabled={!!busy}
            onClick={() => act('activate', () => api.updateSource(source.id, { status: 'active' }))}
          >
            Activate
          </button>
        )}
        {source.status === 'active' && (
          <button
            disabled={!!busy}
            onClick={() => act('pause', () => api.updateSource(source.id, { status: 'paused' }))}
          >
            Pause
          </button>
        )}
        <button
          disabled={!!busy}
          onClick={() => act('scan', () => api.scanSource(source.id))}
        >
          {busy === 'scan' ? 'Scanning… (this takes a minute)' : 'Scan now'}
        </button>
        <div className="spacer" />
        <button
          className="danger"
          disabled={!!busy}
          onClick={() => {
            if (!confirm('Remove this source? Projects it already found are kept.')) return;
            act('delete', () => api.deleteSource(source.id));
          }}
        >
          Remove
        </button>
      </div>
    </Modal>
  );
}
