import React from 'react';
import { api, type Budget } from '../api';
import { ErrorNote, Field, money, useAsync } from '../components/ui';

const FIELDS: {
  key: string;
  label: string;
  hint: string;
  type?: 'number' | 'select';
  options?: string[];
}[] = [
  {
    key: 'monthlyBudgetUsd',
    label: 'Monthly budget (USD)',
    hint: 'Hard ceiling. Once estimated spend reaches this, all AI work stops until next month.',
    type: 'number',
  },
  {
    key: 'perRunBudgetUsd',
    label: 'Per-run budget (USD)',
    hint: 'Hard ceiling for one scheduled pass or one manual action. Stops a single run from running away.',
    type: 'number',
  },
  {
    key: 'assessIntervalHours',
    label: 'Hours between coverage reviews',
    hint: 'How often the system asks itself whether it has enough sources, and goes finding more if not.',
    type: 'number',
  },
  {
    key: 'maxSourcesPerTick',
    label: 'Sources scanned per pass',
    hint: 'Higher finds leads faster and costs more. Sources are scanned best-performing first.',
    type: 'number',
  },
  {
    key: 'maxResearchPerTick',
    label: 'Projects researched per pass',
    hint: 'How many tracked projects get a deep research pass each time.',
    type: 'number',
  },
  {
    key: 'targetActiveSources',
    label: 'Target active sources per profile',
    hint: 'Discovery keeps adding sources until a profile has about this many.',
    type: 'number',
  },
  {
    key: 'minRelevance',
    label: 'Minimum relevance to save a lead (0-100)',
    hint: 'Candidates scoring below this against your profile are discarded rather than saved.',
    type: 'number',
  },
  {
    key: 'webFetchMaxUses',
    label: 'Max documents opened per call',
    hint: 'The strongest cost dial in the app. Each document opened is re-read on every later step of the same call, so cost climbs faster than linearly. Lower means cheaper and shallower.',
    type: 'number',
  },
  {
    key: 'webFetchMaxContentTokens',
    label: 'Max tokens read per document',
    hint: 'How much of each page or PDF is pulled into context. 25,000 is roughly 40 pages of agenda text.',
    type: 'number',
  },
  {
    key: 'webSearchMaxUses',
    label: 'Max web searches per call',
    hint: 'Searches are billed per request on top of tokens.',
    type: 'number',
  },
  {
    key: 'effort',
    label: 'Reasoning effort',
    hint: 'Higher effort digs deeper per source and costs more tokens.',
    type: 'select',
    options: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
];

export function Settings() {
  const settings = useAsync(() => api.settings(), []);
  const budget = useAsync<Budget>(() => api.budget(), []);
  const models = useAsync(() => api.models(), []);
  const [form, setForm] = React.useState<Record<string, string> | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (settings.data) setForm({ ...settings.data.settings });
  }, [settings.data]);

  if (!form) return <div className="empty">Loading…</div>;

  const b = budget.data;
  const pct = b && b.monthlyCapUsd > 0 ? Math.min(100, (b.monthToDateUsd / b.monthlyCapUsd) * 100) : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>How hard the system works, and how much it is allowed to spend doing it.</p>
        </div>
      </div>

      <ErrorNote error={error ?? settings.error} />

      {b && (
        <div className="card">
          <h2>Spend this month ({b.month})</h2>
          <div className="inline">
            <div style={{ flex: 1, minWidth: 220 }}>
              <div className={`meter${b.exhausted ? ' over' : ''}`}>
                <i style={{ width: `${pct}%` }} />
              </div>
              <div className="small muted">
                {money(b.monthToDateUsd)} of {money(b.monthlyCapUsd)} · {money(b.remainingUsd)} left
              </div>
            </div>
          </div>
          {b.exhausted && (
            <div className="banner warn" style={{ marginTop: 12, marginBottom: 0 }}>
              Budget reached — AI work is paused. Raise the monthly budget below to resume.
            </div>
          )}

          {(b.byPurpose?.length ?? 0) > 0 && (
            <div className="grid two" style={{ marginTop: 16 }}>
              <div>
                <h2 style={{ fontSize: 13 }}>By activity</h2>
                <table>
                  <tbody>
                    {b.byPurpose!.map((r) => (
                      <tr key={r.purpose}>
                        <td className="small">{r.purpose}</td>
                        <td className="small muted" style={{ width: 70 }}>
                          {r.calls} calls
                        </td>
                        <td className="small" style={{ width: 70, textAlign: 'right' }}>
                          {money(r.cost)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <h2 style={{ fontSize: 13 }}>By day</h2>
                <table>
                  <tbody>
                    {b.daily!.slice(-12).map((r) => (
                      <tr key={r.day}>
                        <td className="small">{r.day}</td>
                        <td className="small muted" style={{ width: 70 }}>
                          {r.calls} calls
                        </td>
                        <td className="small" style={{ width: 70, textAlign: 'right' }}>
                          {money(r.cost)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <p className="tiny muted" style={{ marginBottom: 0 }}>
            Costs are estimated locally from token counts and published per-token prices, so they
            will be close to but not identical with your Anthropic invoice.
          </p>
        </div>
      )}

      <div className="card">
        <h2>Model</h2>
        <p className="tiny muted" style={{ marginTop: -6 }}>
          Queried live from your accounts, so this is what you can actually use. Picking a
          model picks its vendor too. Restart after changing so the key is re-verified.
        </p>
        {models.error && <ErrorNote error={models.error} />}
        <div className="field">
          <label htmlFor="model-select">Model</label>
          <select
            id="model-select"
            name="model"
            value={form.model ?? ''}
            onChange={(e) => setForm({ ...form, model: e.target.value })}
          >
            {(models.data ?? []).map((p) =>
              p.models.length === 0 ? null : (
                <optgroup key={p.provider} label={p.provider === 'openai' ? 'OpenAI' : 'Anthropic'}>
                  {p.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.id} — ${m.inputPerMTok}/${m.outputPerMTok} per MTok
                      {m.priced ? '' : ' (price unknown)'}
                    </option>
                  ))}
                </optgroup>
              ),
            )}
            {/* Keep the saved value selectable even if that account is no longer configured. */}
            {!(models.data ?? []).some((p) => p.models.some((m) => m.id === form.model)) && (
              <option value={form.model}>{form.model} (not available on a configured key)</option>
            )}
          </select>
        </div>
        {(models.data ?? [])
          .filter((p) => !p.configured || p.error)
          .map((p) => (
            <div className="tiny muted" key={p.provider}>
              {p.provider === 'openai' ? 'OpenAI' : 'Anthropic'}:{' '}
              {p.error ? p.error : `no ${p.provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} set — its models are hidden`}
            </div>
          ))}
      </div>

      <div className="card">
        <h2>Configuration</h2>
        <div className="grid two">
          {FIELDS.map((f) => (
            <Field label={f.label} hint={f.hint} key={f.key}>
              {(id) =>
                f.type === 'select' ? (
                  <select
                    id={id}
                    name={f.key}
                    value={form[f.key] ?? ''}
                    onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                  >
                    {f.options!.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={id}
                    name={f.key}
                    type="number"
                    step="any"
                    value={form[f.key] ?? ''}
                    onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                  />
                )
              }
            </Field>
          ))}
        </div>

        <div className="inline">
          {saved && <span className="small muted">Saved.</span>}
          <div className="spacer" />
          <button
            className="primary"
            onClick={async () => {
              setError(null);
              try {
                await api.saveSettings(form);
                setSaved(true);
                setTimeout(() => setSaved(false), 2500);
                budget.reload();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            Save settings
          </button>
        </div>
      </div>
    </>
  );
}
