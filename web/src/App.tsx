import React from 'react';
import { api, type Profile } from './api';
import { Dashboard } from './pages/Dashboard';
import { Profiles } from './pages/Profiles';
import { Sources } from './pages/Sources';
import { Projects } from './pages/Projects';
import { ProjectDetail } from './pages/ProjectDetail';
import { Settings } from './pages/Settings';
import { ActivityPage } from './pages/Activity';

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
  { hash: '#/settings', label: 'Settings' },
];

export function App() {
  const hash = useHashRoute();
  const [profiles, setProfiles] = React.useState<Profile[]>([]);
  const [profileId, setProfileId] = React.useState(
    () => localStorage.getItem('leadman.profile') ?? '',
  );

  const loadProfiles = React.useCallback(() => {
    api.profiles().then(setProfiles).catch(() => setProfiles([]));
  }, []);

  React.useEffect(loadProfiles, [loadProfiles, hash]);

  React.useEffect(() => {
    localStorage.setItem('leadman.profile', profileId);
  }, [profileId]);

  // Drop a stale selection if that profile was deleted.
  React.useEffect(() => {
    if (profileId && profiles.length && !profiles.some((p) => p.id === profileId)) {
      setProfileId('');
    }
  }, [profiles, profileId]);

  const nav = (to: string) => {
    window.location.hash = to;
  };

  const projectMatch = hash.match(/^#\/projects\/(.+)$/);
  const base = hash.split('/')[1] ?? '';

  let page: React.ReactNode;
  if (projectMatch) page = <ProjectDetail id={projectMatch[1]} nav={nav} />;
  else if (base === 'projects') page = <Projects profileId={profileId} />;
  else if (base === 'sources') page = <Sources profileId={profileId} profiles={profiles} />;
  else if (base === 'profiles') page = <Profiles />;
  else if (base === 'activity') page = <ActivityPage />;
  else if (base === 'settings') page = <Settings />;
  else page = <Dashboard profileId={profileId} nav={nav} />;

  const activeHash = projectMatch ? '#/projects' : `#/${base}`;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          Lead<span>man</span>
          <small>project leads for architects</small>
        </div>

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
          {NAV.map((n) => {
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
        <div className="tiny muted" style={{ padding: '0 8px' }}>
          Runs locally. Data lives in <code>data/leadman.db</code>.
        </div>
      </aside>

      <main className="main">{page}</main>
    </div>
  );
}
