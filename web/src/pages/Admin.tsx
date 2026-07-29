import React from 'react';
import { api, type Session } from '../api';
import { Badge, ErrorNote, Field, Modal, money, timeAgo, useAsync } from '../components/ui';

/**
 * Operating the installation: every account, every user, and the one budget
 * ceiling that bounds them all.
 *
 * Site admins only. This is the only view in the app that looks across
 * accounts, and it is deliberately read-mostly — actual work happens by
 * switching into an account.
 */
export function Admin({ session, onSession }: { session: Session; onSession: (s: Session) => void }) {
  const accounts = useAsync(() => api.adminAccounts(), []);
  const users = useAsync(() => api.adminUsers(), []);
  const site = useAsync(() => api.siteSettings(), []);
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      accounts.reload();
      users.reload();
      site.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function enter(accountId: string) {
    setError(null);
    try {
      onSession(await api.switchAccount(accountId));
      window.location.hash = '#/';
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Administration</h1>
          <p>Every account on this installation, and the spend ceiling that covers all of them.</p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>
          New account
        </button>
      </div>

      <ErrorNote error={error} />

      <SiteBudget site={site} onSave={(v) => act(() => api.saveSiteSettings(v))} />

      <div className="card">
        <h2>
          Accounts <span className="count">({accounts.data?.length ?? 0})</span>
        </h2>
        <div className="stack">
          {(accounts.data ?? []).map((a) => (
            <div className="item" key={a.id}>
              <div className="inline">
                <div>
                  <div className="title">
                    {a.name} {!a.active && <Badge tone="danger">inactive</Badge>}
                    {a.id === session.accountId && <Badge tone="accent">current</Badge>}
                  </div>
                  <div className="meta">
                    <span>{a.member_count} member(s)</span>
                    <span>{a.profile_count} profile(s)</span>
                    <span>{a.project_count} project(s)</span>
                    <span>{money(a.monthToDateUsd)} this month</span>
                  </div>
                </div>
                <div className="spacer" />
                <button className="small" onClick={() => enter(a.id)}>
                  Enter
                </button>
                <button
                  className="small"
                  onClick={() => act(() => api.updateAccount(a.id, { active: !a.active }))}
                >
                  {a.active ? 'Deactivate' : 'Reactivate'}
                </button>
              </div>
            </div>
          ))}
          {accounts.data?.length === 0 && <div className="empty">No accounts yet.</div>}
        </div>
        <p className="tiny muted" style={{ marginBottom: 0 }}>
          Entering an account you are not a member of is recorded in the access log.
        </p>
      </div>

      <div className="card">
        <h2>
          Users <span className="count">({users.data?.length ?? 0})</span>
        </h2>
        <div className="stack">
          {(users.data ?? []).map((u) => {
            const isMe = u.id === session.user.id;
            return (
              <div className="item" key={u.id}>
                <div className="inline">
                  <div>
                    <div className="title">
                      {u.name || u.email} {isMe && <span className="muted tiny">(you)</span>}
                      {Boolean(u.is_site_admin) && <Badge tone="accent">site admin</Badge>}
                      {!u.active && <Badge tone="danger">disabled</Badge>}
                    </div>
                    <div className="meta">
                      <span>{u.email}</span>
                      <span>last signed in {timeAgo(u.last_login_at)}</span>
                      <span>
                        {u.accounts.length === 0
                          ? 'no accounts'
                          : u.accounts.map((m) => `${m.account_name} (${m.role})`).join(', ')}
                      </span>
                    </div>
                  </div>
                  <div className="spacer" />
                  {/* Removing your own access is not recoverable from in here. */}
                  <button
                    className="small"
                    disabled={isMe}
                    onClick={() =>
                      act(() => api.updateUser(u.id, { isSiteAdmin: !u.is_site_admin }))
                    }
                  >
                    {u.is_site_admin ? 'Revoke admin' : 'Make site admin'}
                  </button>
                  <button
                    className="small danger"
                    disabled={isMe}
                    onClick={() => act(() => api.updateUser(u.id, { active: !u.active }))}
                  >
                    {u.active ? 'Disable' : 'Enable'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {creating && (
        <NewAccountModal
          onClose={() => {
            setCreating(false);
            accounts.reload();
          }}
        />
      )}
    </div>
  );
}

function SiteBudget({
  site,
  onSave,
}: {
  site: ReturnType<typeof useAsync<Awaited<ReturnType<typeof api.siteSettings>>>>;
  onSave: (v: Record<string, string>) => void;
}) {
  const [cap, setCap] = React.useState('');
  React.useEffect(() => {
    if (site.data) setCap(site.data.settings.globalMonthlyBudgetUsd);
  }, [site.data]);

  if (!site.data) return null;
  const spent = site.data.monthToDateUsd;
  const capNum = Number(site.data.settings.globalMonthlyBudgetUsd) || 0;
  const pct = capNum > 0 ? Math.min(100, (spent / capNum) * 100) : 0;

  return (
    <div className="card">
      <h2>Installation budget</h2>
      <p className="small muted" style={{ marginTop: 0 }}>
        Every account bills to the same provider API key, so per-account caps cannot bound the total.
        This one can: no account can start paid work once the installation reaches it.
      </p>
      <div className="meter" style={{ maxWidth: 420 }}>
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="small muted" style={{ marginBottom: 12 }}>
        {money(spent)} of {money(capNum)} spent across all accounts this month
      </div>
      <div className="row">
        <Field label="Monthly ceiling (USD)" className="field shrink">
          {(id) => (
            <input
              id={id}
              type="number"
              min="0"
              step="1"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
            />
          )}
        </Field>
        <div className="shrink">
          <button onClick={() => onSave({ globalMonthlyBudgetUsd: cap })}>Save</button>
        </div>
      </div>
    </div>
  );
}

function NewAccountModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = React.useState('');
  const [ownerEmail, setOwnerEmail] = React.useState('');
  const [result, setResult] = React.useState<Awaited<ReturnType<typeof api.createAccount>> | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setResult(await api.createAccount(name, ownerEmail));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="New account" onClose={onClose}>
      {result ? (
        <>
          <div className="banner ok">Created {result.account.name}.</div>
          {result.invite ? (
            <>
              <p className="small">
                Send this link to <strong>{result.invite.email}</strong> to make them the first
                owner. It is shown only once.
              </p>
              <input
                readOnly
                value={result.invite.url}
                onFocus={(e) => e.currentTarget.select()}
                className="mono"
              />
              <div className="inline" style={{ marginTop: 12 }}>
                <button
                  className="primary"
                  onClick={() => {
                    navigator.clipboard?.writeText(result.invite!.url);
                    setCopied(true);
                  }}
                >
                  {copied ? 'Copied' : 'Copy link'}
                </button>
                <button onClick={onClose}>Done</button>
              </div>
            </>
          ) : (
            <>
              <p className="small">
                {result.ownerAdded
                  ? `${result.ownerAdded} already had a login and is now an owner.`
                  : 'No owner yet — invite one from the account’s People page.'}
              </p>
              <button onClick={onClose}>Done</button>
            </>
          )}
        </>
      ) : (
        <form onSubmit={submit}>
          <ErrorNote error={error} />
          <Field label="Account name">
            {(id) => (
              <input
                id={id}
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                required
              />
            )}
          </Field>
          <Field
            label="First owner's email"
            hint="Optional. An existing user becomes owner immediately; a new address gets an invite link."
          >
            {(id) => (
              <input
                id={id}
                type="email"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
              />
            )}
          </Field>
          <button className="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </form>
      )}
    </Modal>
  );
}
