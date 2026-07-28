import React from 'react';
import { api, type WorkType } from '../api';
import { Badge, ErrorNote, Field, Modal, timeAgo, useAsync } from './ui';

const EXAMPLES = [
  {
    name: 'Roof replacement — large institutional buildings',
    description:
      'Roof replacement and re-roofing on schools, gyms, hospitals, and municipal buildings over roughly 20,000 sq ft. We want to hear about it when the district or agency starts budgeting for it — deferred maintenance lists, facility condition reports, storm damage claims — not when the bid drops. Not interested in new construction, residential roofing, or single-ply repairs under $250k.',
  },
  {
    name: 'Restaurant chain multi-site expansion',
    description:
      'Regional and national restaurant chains opening new locations in our area. We do the site adaptation and permit set for each new store, so one chain entering the market is worth many projects. Earliest useful signal is a conditional use or site plan application for a drive-through, or a brokerage announcement of a build-to-suit. Not interested in one-off independent restaurants or interior refreshes.',
  },
  {
    name: 'Car wash chain rollout',
    description:
      'Express car wash operators expanding into the region — the tunnel-format chains that build 5 to 15 sites in a metro. Signals are land acquisition, zoning variance requests for wash facilities, and franchise announcements. Not interested in self-serve bays or gas station add-ons.',
  },
];

export function WorkTypesPanel({ profileId }: { profileId: string }) {
  const { data, error, loading, reload } = useAsync<WorkType[]>(
    () => api.workTypes(profileId),
    [profileId],
  );
  const [editing, setEditing] = React.useState<WorkType | 'new' | null>(null);

  if (loading && !data) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="inline" style={{ marginBottom: 10 }}>
        <div>
          <strong style={{ fontSize: 14 }}>Types of work to look for</strong>
          <div className="tiny muted">
            Each one gets its own hunting strategy, its own sources, and its own leads.
          </div>
        </div>
        <div className="spacer" />
        <button className="small" onClick={() => setEditing('new')}>
          Add a work type
        </button>
      </div>

      <ErrorNote error={error} />

      {data?.length === 0 ? (
        <div className="banner info" style={{ marginBottom: 0 }}>
          No work types yet — every construction project in range will be scored against your
          profile description alone. Add one to narrow the hunt to your specialization.
        </div>
      ) : (
        <div className="stack">
          {data?.map((t) => (
            <div className="item" key={t.id}>
              <div className="inline">
                <span className="title">{t.name}</span>
                {!t.active && <Badge>paused</Badge>}
                {!t.planned_at && <Badge tone="warn">not planned yet</Badge>}
                <div className="spacer" />
                <Badge tone={t.stats.activeSources > 0 ? 'ok' : 'warn'}>
                  {t.stats.activeSources} source{t.stats.activeSources === 1 ? '' : 's'}
                </Badge>
                <Badge>{t.stats.projects} lead{t.stats.projects === 1 ? '' : 's'}</Badge>
                <button className="small" onClick={() => setEditing(t)}>
                  Edit
                </button>
              </div>
              {t.description && <div className="body">{t.description}</div>}

              {t.source_strategy && (
                <details style={{ marginTop: 8 }}>
                  <summary className="tiny muted" style={{ cursor: 'pointer' }}>
                    How the system hunts for this ({timeAgo(t.planned_at)})
                  </summary>
                  <div className="small" style={{ marginTop: 6 }}>
                    {t.source_strategy}
                  </div>
                  {t.lead_signals.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div className="tiny muted">Earliest signals it watches for</div>
                      <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                        {t.lead_signals.map((s) => (
                          <li key={s}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {t.exclusions && (
                    <div className="small" style={{ marginTop: 8 }}>
                      <span className="muted">Deliberately excluded: </span>
                      {t.exclusions}
                    </div>
                  )}
                  {t.keywords.length > 0 && (
                    <div className="inline" style={{ gap: 4, marginTop: 8 }}>
                      {t.keywords.slice(0, 18).map((k) => (
                        <Badge key={k}>{k}</Badge>
                      ))}
                    </div>
                  )}
                </details>
              )}

              <div className="inline" style={{ marginTop: 10 }}>
                <Action
                  label={t.planned_at ? 'Re-plan strategy' : 'Plan strategy'}
                  run={() => api.planWorkType(t.id)}
                  onDone={reload}
                />
                <Action
                  label="Find sources for this"
                  run={() => api.discoverForWorkType(t.id)}
                  onDone={reload}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <WorkTypeEditor
          profileId={profileId}
          workType={editing === 'new' ? null : editing}
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

function Action({
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

function WorkTypeEditor({
  profileId,
  workType,
  onClose,
  onSaved,
}: {
  profileId: string;
  workType: WorkType | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState(workType?.name ?? '');
  const [description, setDescription] = React.useState(workType?.description ?? '');
  const [active, setActive] = React.useState(workType?.active ?? true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const descriptionChanged = workType ? description !== workType.description : true;

  return (
    <Modal title={workType ? 'Edit work type' : 'New work type'} onClose={onClose}>
      <ErrorNote error={error} />

      <Field label="Name">
        {(id) => (
          <input
            id={id}
            name="work_type_name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Roof replacement — large institutional buildings"
          />
        )}
      </Field>

      <Field
        label="What counts as this kind of work?"
        hint="Describe the work, the earliest point you'd want to hear about it, and what to exclude. The system turns this into a hunting strategy — where these leads surface differs enormously between, say, public roofing work and a franchise rollout."
      >
        {(id) => (
          <textarea
            id={id}
            name="work_type_description"
            rows={7}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={EXAMPLES[0].description}
          />
        )}
      </Field>

      {!workType && (
        <div style={{ marginBottom: 14 }}>
          <div className="tiny muted" style={{ marginBottom: 6 }}>
            Or start from an example:
          </div>
          <div className="inline">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.name}
                className="small"
                onClick={() => {
                  setName(ex.name);
                  setDescription(ex.description);
                }}
              >
                {ex.name.split('—')[0].trim()}
              </button>
            ))}
          </div>
        </div>
      )}

      <label className="inline" style={{ fontWeight: 400, cursor: 'pointer' }}>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
        />
        <span className="small">Actively hunt for this</span>
      </label>

      {workType && descriptionChanged && (
        <div className="banner info" style={{ marginTop: 12, marginBottom: 0 }}>
          Changing the description clears the hunting strategy. Re-plan it after saving so
          discovery and scanning use the new definition.
        </div>
      )}

      <div className="inline" style={{ marginTop: 18 }}>
        {workType && (
          <button
            className="danger"
            onClick={async () => {
              if (!confirm(`Delete "${workType.name}"? Leads already found are kept but unlabelled.`))
                return;
              await api.deleteWorkType(workType.id);
              onSaved();
            }}
          >
            Delete
          </button>
        )}
        <div className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button
          className="primary"
          disabled={busy || name.trim().length < 2}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              if (workType) await api.updateWorkType(workType.id, { name, description, active });
              else await api.createWorkType({ profile_id: profileId, name, description, active });
              onSaved();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : workType ? 'Save' : 'Add work type'}
        </button>
      </div>
    </Modal>
  );
}
