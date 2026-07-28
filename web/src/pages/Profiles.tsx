import React from 'react';
import { api, type Profile } from '../api';
import { AreaMap } from '../components/AreaMap';
import { WorkTypesPanel } from '../components/WorkTypes';
import { Badge, ErrorNote, Field, timeAgo, useAsync } from '../components/ui';

const BLANK = {
  name: '',
  description: '',
  center_label: 'Baton Rouge, Louisiana',
  center_lat: 30.4515,
  center_lng: -91.1871,
  radius_miles: 60,
};

const EXAMPLE = `We are a small architecture firm in Baton Rouge. We want leads for
K-12 and higher-education buildings, municipal facilities (libraries, fire and
police stations, courthouses, community centers), and healthcare clinics.

Typical construction value $2M-$40M. We are strongest on public work that goes
through a formal RFQ/RFP process, and we want to hear about a project during
planning or budgeting — well before the solicitation is published.

Not interested in: single-family residential, warehouse/industrial shells, road
and drainage work, or projects where an architect has already been selected.`;

export function Profiles() {
  const { data, error, loading, reload } = useAsync<Profile[]>(() => api.profiles(), []);
  const [editing, setEditing] = React.useState<Profile | 'new' | null>(null);

  if (loading && !data) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Search profiles</h1>
          <p>
            Describe the kind of work you want and the area to look in. Everything the system does
            — which sources it hunts for, what counts as a lead — comes from this description.
          </p>
        </div>
        <button className="primary" onClick={() => setEditing('new')}>
          New profile
        </button>
      </div>

      <ErrorNote error={error} />

      {data?.length === 0 && (
        <div className="banner info">
          No profiles yet. Create one to get started — the first scheduled pass will go find lead
          sources for it automatically.
        </div>
      )}

      <div className="stack">
        {data?.map((p) => (
          <div className="card" key={p.id}>
            <div className="inline">
              <h2 style={{ margin: 0 }}>{p.name}</h2>
              {!p.active && <Badge tone="neutral">paused</Badge>}
              <div className="spacer" />
              <button className="small" onClick={() => setEditing(p)}>
                Edit
              </button>
            </div>
            <div className="meta small muted" style={{ marginBottom: 10 }}>
              {p.center_label} · {p.radius_miles} mile radius · assessed {timeAgo(p.last_assessed_at)}
            </div>

            <div className="grid two">
              <div>
                <AreaMap
                  lat={p.center_lat}
                  lng={p.center_lng}
                  radiusMiles={p.radius_miles}
                  height={230}
                />
              </div>
              <div>
                <div className="grid stats" style={{ gridTemplateColumns: '1fr 1fr' }}>
                  <div className="stat">
                    <div className="label">Active sources</div>
                    <div className="value">{p.stats.activeSources}</div>
                    <div className="sub">{p.stats.totalSources} total</div>
                  </div>
                  <div className="stat">
                    <div className="label">Projects</div>
                    <div className="value">{p.stats.discovered + p.stats.tracked}</div>
                    <div className="sub">
                      {p.stats.discovered} new · {p.stats.tracked} tracked
                    </div>
                  </div>
                </div>

                {p.jurisdictions.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <div className="tiny muted" style={{ marginBottom: 4 }}>
                      Jurisdictions the system identified in range
                    </div>
                    <div className="inline" style={{ gap: 5 }}>
                      {p.jurisdictions.slice(0, 14).map((j) => (
                        <Badge key={j}>{j}</Badge>
                      ))}
                      {p.jurisdictions.length > 14 && (
                        <span className="tiny muted">+{p.jurisdictions.length - 14} more</span>
                      )}
                    </div>
                  </div>
                )}

                <div className="inline" style={{ marginTop: 14 }}>
                  <ActionButton
                    label="Find sources now"
                    run={() => api.discover(p.id)}
                    onDone={reload}
                  />
                  <ActionButton
                    label="Assess coverage"
                    run={() => api.assess(p.id)}
                    onDone={reload}
                  />
                </div>
              </div>
            </div>

            <div
              style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}
            >
              <WorkTypesPanel profileId={p.id} />
            </div>

            <details style={{ marginTop: 12 }}>
              <summary className="small muted" style={{ cursor: 'pointer' }}>
                Profile description
              </summary>
              <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
                {p.description}
              </div>
            </details>
          </div>
        ))}
      </div>

      {editing && (
        <ProfileEditor
          profile={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function ActionButton({
  label,
  run,
  onDone,
}: {
  label: string;
  run: () => Promise<{ status: string; error: string }>;
  onDone: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  return (
    <>
      <button
        className="small"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          try {
            const r = await run();
            setMsg(
              r.status === 'ok'
                ? 'Done.'
                : r.status === 'budget_stopped'
                  ? `Stopped: ${r.error}`
                  : `Failed: ${r.error}`,
            );
            onDone();
          } catch (e) {
            setMsg(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Working…' : label}
      </button>
      {msg && <span className="tiny muted">{msg}</span>}
    </>
  );
}

function ProfileEditor({
  profile,
  onClose,
  onSaved,
}: {
  profile: Profile | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState(() =>
    profile
      ? {
          name: profile.name,
          description: profile.description,
          center_label: profile.center_label,
          center_lat: profile.center_lat,
          center_lng: profile.center_lng,
          radius_miles: profile.radius_miles,
        }
      : { ...BLANK },
  );
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState<{ label: string; lat: number; lng: number }[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  async function search() {
    if (query.trim().length < 3) return;
    setError(null);
    try {
      setResults(await api.geocode(query));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = { ...form, radius_miles: Number(form.radius_miles) };
      if (profile) await api.updateProfile(profile.id, body);
      else await api.createProfile(body);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 900 }} onClick={(e) => e.stopPropagation()}>
        <h2>{profile ? 'Edit profile' : 'New search profile'}</h2>
        <ErrorNote error={error} />

        <Field label="Profile name">
          {(id) => (
            <input
              id={id}
              name="name"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Public & institutional work — Capital Region"
            />
          )}
        </Field>

        <div className="field">
          <label htmlFor="profile-description">What kind of work are you looking for?</label>
          <textarea
            id="profile-description"
            name="description"
            rows={9}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder={EXAMPLE}
          />
          <div className="hint">
            Write it the way you'd brief a new employee. Include project types, rough construction
            value, delivery methods you're set up for, and — importantly — what you <em>don't</em>{' '}
            want. This text is what the AI scores every lead against.
            {!form.description && (
              <>
                {' '}
                <button
                  className="small"
                  style={{ marginTop: 6 }}
                  onClick={() => set('description', EXAMPLE)}
                >
                  Use the example
                </button>
              </>
            )}
          </div>
        </div>

        <div className="field">
          <label htmlFor="profile-area-search">Search area</label>
          <div className="row">
            <input
              id="profile-area-search"
              name="area_search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), search())}
              placeholder="Search a place, e.g. Baton Rouge, LA"
            />
            <button className="shrink" onClick={search}>
              Find
            </button>
          </div>
          {results.length > 0 && (
            <div className="stack" style={{ marginTop: 8 }}>
              {results.map((r) => (
                <button
                  key={`${r.lat},${r.lng}`}
                  className="small"
                  style={{ textAlign: 'left' }}
                  onClick={() => {
                    set('center_label', r.label.split(',').slice(0, 3).join(',').trim());
                    set('center_lat', r.lat);
                    set('center_lng', r.lng);
                    setResults([]);
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>
          )}
          <div className="hint">Or click the map to set the center point.</div>
        </div>

        <div className="row" style={{ marginBottom: 12 }}>
          <Field label="Center label" className="">
            {(id) => (
              <input
                id={id}
                name="center_label"
                value={form.center_label}
                onChange={(e) => set('center_label', e.target.value)}
              />
            )}
          </Field>
          <div style={{ maxWidth: 150 }}>
            <label htmlFor="profile-radius">Radius (miles)</label>
            <input
              id="profile-radius"
              name="radius_miles"
              type="number"
              min={1}
              max={500}
              value={form.radius_miles}
              onChange={(e) => set('radius_miles', Number(e.target.value))}
            />
          </div>
        </div>

        <AreaMap
          lat={form.center_lat}
          lng={form.center_lng}
          radiusMiles={Number(form.radius_miles) || 1}
          height={300}
          onPick={(lat, lng) => {
            set('center_lat', lat);
            set('center_lng', lng);
          }}
        />
        <div className="tiny muted" style={{ marginTop: 6 }}>
          Center: {form.center_lat.toFixed(4)}, {form.center_lng.toFixed(4)}
        </div>

        <div className="inline" style={{ marginTop: 18 }}>
          {profile && (
            <button
              className="danger"
              onClick={async () => {
                if (!confirm(`Delete "${profile.name}" and everything found under it?`)) return;
                await api.deleteProfile(profile.id);
                onSaved();
              }}
            >
              Delete profile
            </button>
          )}
          <div className="spacer" />
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={busy || !form.name || form.description.length < 10}
            onClick={save}
          >
            {busy ? 'Saving…' : profile ? 'Save changes' : 'Create profile'}
          </button>
        </div>
      </div>
    </div>
  );
}
