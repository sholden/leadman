import React from 'react';
import { api, type Session } from '../api';
import { ErrorNote, Field, useAsync } from '../components/ui';
import { MIN_PASSWORD_LENGTH } from '../constants';

/**
 * Redeeming an invite link.
 *
 * Two shapes behind one form: a brand-new person choosing a password, and an
 * existing user proving who they are before a second account is attached to
 * them. The server decides which; `userExists` only changes the wording.
 */
export function AcceptInvite({
  token,
  onSignedIn,
}: {
  token: string;
  onSignedIn: (session: Session) => void;
}) {
  const preview = useAsync(() => api.invitePreview(token), [token]);
  const [password, setPassword] = React.useState('');
  const [name, setName] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await api.acceptInvite(token, password, name || undefined);
      window.location.hash = '#/';
      onSignedIn(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (preview.loading) {
    return (
      <div className="auth-shell">
        <div className="auth-card muted">Checking this invite…</div>
      </div>
    );
  }

  if (preview.error || !preview.data) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <h2 style={{ marginTop: 0 }}>This invite can’t be used</h2>
          <ErrorNote error={preview.error} />
          <p className="small muted">
            Invite links expire after 14 days and can only be used once. Ask an owner of the account
            to send you a new one.
          </p>
          <a className="btn" href="#/">
            Go to sign in
          </a>
        </div>
      </div>
    );
  }

  const { email, role, accountName, userExists } = preview.data;

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand" style={{ padding: 0, marginBottom: 14 }}>
          Lead<span>man</span>
        </div>

        <h2 style={{ margin: '0 0 6px', fontSize: 17 }}>
          Join {accountName} as {role === 'owner' ? 'an owner' : 'a member'}
        </h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          This invite is for <strong>{email}</strong>.
        </p>

        <ErrorNote error={error} />

        {userExists ? (
          <>
            <p className="small">
              That address already has a Leadman login. Enter its password to add {accountName} to
              your account.
            </p>
            <Field label="Your existing password">
              {(id) => (
                <input
                  id={id}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  autoFocus
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              )}
            </Field>
          </>
        ) : (
          <>
            <Field label="Your name" hint="Optional — shown to others in the account.">
              {(id) => (
                <input id={id} value={name} autoFocus onChange={(e) => setName(e.target.value)} />
              )}
            </Field>
            <Field label="Choose a password" hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
              {(id) => (
                <input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD_LENGTH}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              )}
            </Field>
          </>
        )}

        <button className="primary" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Joining…' : `Join ${accountName}`}
        </button>
      </form>
    </div>
  );
}
