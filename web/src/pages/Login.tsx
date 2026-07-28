import React from 'react';
import { api, type Session } from '../api';
import { ErrorNote, Field } from '../components/ui';

/**
 * The whole app behind one screen. Deliberately says nothing about whether an
 * address exists — the server gives the same answer either way, and a helpful
 * message here would undo that.
 */
export function Login({ onSignedIn }: { onSignedIn: (session: Session) => void }) {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [needsBootstrap, setNeedsBootstrap] = React.useState(false);

  React.useEffect(() => {
    // Tells someone staring at a login box on a brand-new installation why no
    // password will ever work.
    fetch('/api/health')
      .then((r) => r.json())
      .then((h) => setNeedsBootstrap(Boolean(h.needsBootstrap)))
      .catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await api.login(email, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand" style={{ padding: 0, marginBottom: 18 }}>
          Lead<span>man</span>
          <small>project leads for architects</small>
        </div>

        {needsBootstrap && (
          <div className="banner warn">
            No administrator exists on this installation yet. Set{' '}
            <code>LEADMAN_ADMIN_EMAIL</code> and <code>LEADMAN_ADMIN_PASSWORD</code> and restart the
            server to create the first one.
          </div>
        )}

        <ErrorNote error={error} />

        <Field label="Email">
          {(id) => (
            <input
              id={id}
              type="email"
              autoComplete="username"
              value={email}
              autoFocus
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          )}
        </Field>

        <Field label="Password">
          {(id) => (
            <input
              id={id}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          )}
        </Field>

        <button className="primary" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <p className="tiny muted" style={{ marginTop: 16, marginBottom: 0 }}>
          Accounts are created by an administrator. If you were sent an invite link, open that link
          instead of signing in here.
        </p>
      </form>
    </div>
  );
}
