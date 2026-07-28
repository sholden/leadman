import React from 'react';
import { api, onAuthLost, type Profile, type Session } from './api';
import { Dashboard } from './pages/Dashboard';
import { Profiles } from './pages/Profiles';
import { Sources } from './pages/Sources';
import { Projects } from './pages/Projects';
import { ProjectDetail } from './pages/ProjectDetail';
import { Settings } from './pages/Settings';
import { ActivityPage } from './pages/Activity';
import { Login } from './pages/Login';
import { AcceptInvite } from './pages/AcceptInvite';
import { Members } from './pages/Members';
import { Admin } from './pages/Admin';

function useHashRoute() {
  const [hash, setHash] = React.useState(window.location.hash || '#/');
  React.useEffect(() => {
    const on = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

const NAV = [
  { hash: '#/', label: 'Dashboard' },
  { hash: '#/projects', label: 'Projects' },
  { hash: '#/sources', label: 'Sources' },
  { hash: '#/activity', label: 'Activity' },
  { hash: '#/profiles', label: 'Profiles' },
  { hash: '#/people', label: 'People' },
  { hash: '#/settings', label: 'Settings' },
];

export function App() {
  const hash = useHashRoute();
  const [session, setSession] = React.useState<Session | null>(null);
  const [checking, setChecking] = React.useState(true);

  const inviteMatch = hash.match(/^#\/invite\/(.+)$/);

  // Resolve the existing cookie session once on load.
  React.useEffect(() => {
    api
      .me()
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setChecking(false));
  }, []);

  // Any request coming back 401 — an expired session, a revoked one — drops the
  // whole app to the login screen rather than leaving pages showing errors.
  React.useEffect(() => {
    const off = onAuthLost(() => setSession(null));
    return () => {
      off();
    };
  }, []);

  if (inviteMatch) {
    return <AcceptInvite token={inviteMatch[1]} onSignedIn={setSession} />;
  }
  if (checking) {
    return <div className="auth-shell"><div className="auth-card muted">Loading…</div></div>;
  }
  if (!session) {
    return <Login onSignedIn={setSession} />;
  }
  if (!session.accountId) {
    return <NoAccount session={session} onSignedOut={() => setSession(null)} />;
  }

  return <Shell session={session} onSession={setSession} hash={hash} />;
}

/** A real user who belongs to nothing yet. Signing out is the only useful action. */
function NoAccount({ session, onSignedOut }: { session: Session; onSignedOut: () => void }) {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h2 style={{ marginTop: 0 }}>No account yet</h2>
        <p className="small">
          You are signed in as <strong>{session.user.email}</strong>, but you do not belong to any
          account. Ask an owner to send you an invite link.
        </p>
        <button
          onClick={async () => {
            await api.logout().catch(() => {});
            onSignedOut();
          }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

function Shell({
  session,
  onSession,
  hash,
}: {
  session: Session;
  onSession: (s: Session) => void;
  hash: string;
}) {
  const [profiles, setProfiles] = React.useState<Profile[]>([]);
  const [profileId, setProfileId] = React.useState(
    () => localStorage.getItem('leadman.profile') ?? '',
  );

  const loadProfiles = React.useCallback(() => {
    api.profiles().then(setProfiles).catch(() => setProfiles([]));
  }, []);

  React.useEffect(loadProfiles, [loadProfiles, hash, session.accountId]);

  React.useEffect(() => {
    localStorage.setItem('leadman.profile', profileId);
  }, [profileId]);

  // Drop a stale selection if that profile was deleted — or if we just switched
  // to an account where it never existed.
  React.useEffect(() => {
    if (profileId && profiles.length && !profiles.some((p) => p.id === profileId)) {
      setProfileId('');
    }
  }, [profiles, profileId]);

  const nav = (to: string) => {
    window.location.hash = to;
  };

  async function switchAccount(accountId: string) {
    if (accountId === session.accountId) return;
    // The selected profile belongs to the account we are leaving.
    setProfileId('');
    onSession(await api.switchAccount(accountId));
  }

  const projectMatch = hash.match(/^#\/projects\/(.+)$/);
  const base = hash.split('/')[1] ?? '';

  let page: React.ReactNode;
  if (projectMatch) page = <ProjectDetail id={projectMatch[1]} nav={nav} />;
  else if (base === 'projects') page = <Projects profileId={profileId} />;
  else if (base === 'sources') page = <Sources profileId={profileId} profiles={profiles} />;
  else if (base === 'profiles') page = <Profiles />;
  else if (base === 'activity') page = <ActivityPage />;
  else if (base === 'settings') page = <Settings />;
  else if (base === 'people') page = <Members session={session} onSession={onSession} />;
  else if (base === 'admin' && session.user.isSiteAdmin)
    page = <Admin session={session} onSession={onSession} />;
  else page = <Dashboard profileId={profileId} nav={nav} />;

  const activeHash = projectMatch ? '#/projects' : `#/${base}`;
  const nav_ = session.user.isSiteAdmin
    ? [...NAV, { hash: '#/admin', label: 'Administration' }]
    : NAV;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          Lead<span>man</span>
          <small>project leads for architects</small>
        </div>

        {session.accounts.length > 1 && (
          <div>
            <label className="tiny">Account</label>
            <select
              value={session.accountId ?? ''}
              onChange={(e) => switchAccount(e.target.value)}
            >
              {session.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.role === null ? ' (admin)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        {profiles.length > 1 && (
          <div>
            <label className="tiny">Profile</label>
            <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              <option value="">All profiles</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <nav className="nav">
          {nav_.map((n) => {
            const isActive = n.hash === '#/' ? activeHash === '#/' : activeHash === n.hash;
            const count =
              n.hash === '#/projects'
                ? profiles.reduce((a, p) => a + (profileId && p.id !== profileId ? 0 : p.stats.discovered), 0)
                : n.hash === '#/sources'
                  ? profiles.reduce(
                      (a, p) => a + (profileId && p.id !== profileId ? 0 : p.stats.activeSources),
                      0,
                    )
                  : 0;
            return (
              <a key={n.hash} href={n.hash} className={isActive ? 'active' : ''}>
                {n.label}
                {count > 0 && <span className="badge">{count}</span>}
              </a>
            );
          })}
        </nav>

        <div className="spacer" />

        <div className="who">
          <div className="tiny muted">Signed in as</div>
          <div className="small" title={session.user.email}>
            {session.user.name || session.user.email}
          </div>
          {/* A site admin inside someone else's account should never forget it. */}
          {session.role === null && (
            <div className="tiny badge accent" style={{ marginTop: 4 }}>
              visiting as site admin
            </div>
          )}
          <button
            className="small"
            style={{ marginTop: 8, width: '100%' }}
            onClick={async () => {
              await api.logout().catch(() => {});
              window.location.hash = '#/';
              window.location.reload();
            }}
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="main">{page}</main>
    </div>
  );
}
