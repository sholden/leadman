import React from 'react';
import { api, type Role, type Session } from '../api';
import { Badge, ErrorNote, Field, Modal, timeAgo, useAsync } from '../components/ui';
import { MIN_PASSWORD_LENGTH } from '../constants';

/**
 * Who can reach this account, and how to add someone.
 *
 * Owners see invite management; members see the roster read-only, because the
 * server refuses their writes anyway and offering buttons that always fail is
 * worse than not offering them.
 */
export function Members({ session, onSession }: { session: Session; onSession: (s: Session) => void }) {
  const isOwner = session.role === 'owner' || session.user.isSiteAdmin;
  const members = useAsync(() => api.members(), []);
  const invites = useAsync(() => (isOwner ? api.invites() : Promise.resolve([])), [isOwner]);
  const [error, setError] = React.useState<string | null>(null);
  const [inviting, setInviting] = React.useState(false);
  const [showPassword, setShowPassword] = React.useState(false);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      members.reload();
      invites.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const owners = (members.data ?? []).filter((m) => m.role === 'owner').length;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>People</h1>
          <p>
            Everyone who can reach <strong>{session.account?.name}</strong>. Owners can invite
            others and change roles.
          </p>
        </div>
        <div className="inline">
          <button onClick={() => setShowPassword(true)}>Change my password</button>
          {isOwner && (
            <button className="primary" onClick={() => setInviting(true)}>
              Invite someone
            </button>
          )}
        </div>
      </div>

      <ErrorNote error={error} />
      <ErrorNote error={members.error} />

      <div className="card">
        <h2>
          Members <span className="count">({members.data?.length ?? 0})</span>
        </h2>
        <div className="stack">
          {(members.data ?? []).map((m) => {
            const isMe = m.id === session.user.id;
            // The last owner is load-bearing: without one, nobody can invite or
            // change roles ever again.
            const lastOwner = m.role === 'owner' && owners === 1;
            return (
              <div className="item" key={m.id}>
                <div className="inline">
                  <div>
                    <div className="title">
                      {m.name || m.email} {isMe && <span className="muted tiny">(you)</span>}
                    </div>
                    <div className="meta">
                      <span>{m.email}</span>
                      <span>last signed in {timeAgo(m.last_login_at)}</span>
                      {!m.active && <Badge tone="danger">disabled</Badge>}
                      {Boolean(m.is_site_admin) && <Badge tone="accent">site admin</Badge>}
                    </div>
                  </div>
                  <div className="spacer" />
                  {isOwner ? (
                    <>
                      <select
                        value={m.role}
                        disabled={lastOwner}
                        title={lastOwner ? 'This is the account’s last owner.' : undefined}
                        onChange={(e) => act(() => api.setMemberRole(m.id, e.target.value as Role))}
                      >
                        <option value="owner">Owner</option>
                        <option value="member">Member</option>
                      </select>
                      <button
                        className="small danger"
                        disabled={lastOwner}
                        onClick={() => {
                          if (confirm(`Remove ${m.email} from this account?`)) {
                            act(() => api.removeMember(m.id));
                          }
                        }}
                      >
                        Remove
                      </button>
                    </>
                  ) : (
                    <Badge tone={m.role === 'owner' ? 'accent' : 'neutral'}>{m.role}</Badge>
                  )}
                </div>
              </div>
            );
          })}
          {members.data?.length === 0 && <div className="empty">Nobody yet.</div>}
        </div>
      </div>

      {isOwner && <PendingInvites invites={invites} onAct={act} />}

      {inviting && (
        <InviteModal
          onClose={() => {
            setInviting(false);
            invites.reload();
          }}
        />
      )}
      {showPassword && (
        <PasswordModal onClose={() => setShowPassword(false)} onDone={() => onSession(session)} />
      )}
    </div>
  );
}

function PendingInvites({
  invites,
  onAct,
}: {
  invites: ReturnType<typeof useAsync<Awaited<ReturnType<typeof api.invites>>>>;
  onAct: (fn: () => Promise<unknown>) => void;
}) {
  const pending = (invites.data ?? []).filter((i) => !i.accepted_at && !i.revoked_at);
  if (pending.length === 0) return null;

  return (
    <div className="card">
      <h2>
        Pending invites <span className="count">({pending.length})</span>
      </h2>
      <div className="stack">
        {pending.map((i) => (
          <div className="item" key={i.id}>
            <div className="inline">
              <div>
                <div className="title">{i.email}</div>
                <div className="meta">
                  <span>invited as {i.role}</span>
                  <span>expires {new Date(i.expires_at).toLocaleDateString()}</span>
                  {i.invited_by_email && <span>by {i.invited_by_email}</span>}
                </div>
              </div>
              <div className="spacer" />
              <button className="small danger" onClick={() => onAct(() => api.revokeInvite(i.id))}>
                Revoke
              </button>
            </div>
          </div>
        ))}
      </div>
      <p className="tiny muted" style={{ marginBottom: 0 }}>
        Leadman does not send email. The link is shown once when you create the invite — if you lost
        it, revoke this one and issue another.
      </p>
    </div>
  );
}

function InviteModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<Role>('member');
  const [url, setUrl] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setUrl((await api.createInvite(email, role)).url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Invite someone" onClose={onClose}>
      {url ? (
        <>
          <div className="banner ok">
            Invite created for <strong>{email}</strong>.
          </div>
          <p className="small">
            Send them this link yourself — Leadman has no mailer, and this is the only time the link
            is shown.
          </p>
          <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="mono" />
          <div className="inline" style={{ marginTop: 12 }}>
            <button
              className="primary"
              onClick={() => {
                navigator.clipboard?.writeText(url);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </button>
            <button onClick={onClose}>Done</button>
          </div>
        </>
      ) : (
        <form onSubmit={submit}>
          <ErrorNote error={error} />
          <Field
            label="Email address"
            hint="The invite can only be redeemed by someone signing in with this address."
          >
            {(id) => (
              <input
                id={id}
                type="email"
                value={email}
                autoFocus
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            )}
          </Field>
          <Field label="Role" hint="Owners can invite others and manage membership.">
            {(id) => (
              <select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                <option value="member">Member</option>
                <option value="owner">Owner</option>
              </select>
            )}
          </Field>
          <button className="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create invite link'}
          </button>
        </form>
      )}
    </Modal>
  );
}

function PasswordModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Change your password" onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorNote error={error} />
        <Field label="Current password">
          {(id) => (
            <input
              id={id}
              type="password"
              autoComplete="current-password"
              value={current}
              autoFocus
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          )}
        </Field>
        <Field
          label="New password"
          hint={`At least ${MIN_PASSWORD_LENGTH} characters. This signs out your other devices.`}
        >
          {(id) => (
            <input
              id={id}
              type="password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
            />
          )}
        </Field>
        <button className="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </Modal>
  );
}
