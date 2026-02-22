import { useEffect, useState, useCallback, useRef } from 'react';
import {
  type DashboardSystem,
  type CurrentUser,
  fetchDashboardSystems,
  fetchDiscoverySuggestionCount,
  getStoredUser,
  setStoredUser,
  getStoredApiKey,
  clearSession,
  logout as apiLogout,
  fetchCurrentUser,
} from './api';
import { SystemCard } from './components/SystemCard';
import { DrillDown } from './components/DrillDown';
import { LoginForm } from './components/LoginForm';
import { SettingsView } from './components/SettingsView';
import { LlmUsageView } from './components/LlmUsageView';
import { EventExplorerView } from './components/EventExplorerView';
import { AskAiPanel } from './components/AskAiPanel';
import './index.css';

type View = 'dashboard' | 'settings' | 'ai-usage' | 'events';

/** Check if user has a specific permission. */
export function hasPermission(user: CurrentUser | null, perm: string): boolean {
  if (!user) return false;
  // Administrators get everything
  if (user.role === 'administrator') return true;
  return user.permissions?.includes(perm) ?? false;
}

export default function App() {
  const [authenticated, setAuthenticated] = useState(!!getStoredApiKey());
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(getStoredUser());
  const [view, setView] = useState<View>('dashboard');
  const [systems, setSystems] = useState<DashboardSystem[]>([]);
  const [selectedSystem, setSelectedSystem] = useState<DashboardSystem | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [discoveryCount, setDiscoveryCount] = useState(0);
  const [settingsInitialTab, setSettingsInitialTab] = useState<string | undefined>(undefined);
  const fetchId = useRef(0);

  // Validate session and load user info on app load
  useEffect(() => {
    if (authenticated && !currentUser) {
      fetchCurrentUser()
        .then((res) => {
          if (res.user) {
            setCurrentUser(res.user);
            setStoredUser(res.user);
          }
        })
        .catch(() => {
          // Session expired
          clearSession();
          setAuthenticated(false);
          setCurrentUser(null);
        });
    }
  }, [authenticated, currentUser]);

  const loadSystems = useCallback(async (isManual = false) => {
    const id = ++fetchId.current;
    setSystems((prev) => {
      if (prev.length === 0) setLoading(true);
      return prev;
    });
    if (isManual) {
      setRefreshing(true);
    }
    setError('');

    try {
      const [data, discCount] = await Promise.all([
        fetchDashboardSystems(),
        fetchDiscoverySuggestionCount().catch(() => ({ count: 0 })),
      ]);
      if (id !== fetchId.current) return;
      setSystems(data);
      setDiscoveryCount(discCount.count);
      setLastRefreshed(new Date());
      setSelectedSystem((prev) => {
        if (!prev) return null;
        const updated = data.find((s) => s.id === prev.id);
        return updated ?? null;
      });
    } catch (err: unknown) {
      if (id !== fetchId.current) return;
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Authentication')) {
        handleLogout();
      }
      setError(message || 'Unknown error');
    } finally {
      if (id === fetchId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    if (authenticated) {
      loadSystems();
      const interval = setInterval(() => loadSystems(), 30_000);
      return () => clearInterval(interval);
    }
  }, [authenticated, loadSystems]);

  const handleLogin = (user: CurrentUser) => {
    setCurrentUser(user);
    setAuthenticated(true);
  };

  const handleLogout = useCallback(async () => {
    await apiLogout();
    setAuthenticated(false);
    setCurrentUser(null);
    setSystems([]);
    setSelectedSystem(null);
    setLastRefreshed(null);
    setView('dashboard');
  }, []);

  if (!authenticated) {
    return <LoginForm onLogin={handleLogin} />;
  }

  const switchToSettings = () => {
    setView('settings');
    setSelectedSystem(null);
  };

  const switchToDashboard = () => {
    setSelectedSystem(null);
    setView('dashboard');
    loadSystems(true);
  };

  const switchToAiUsage = () => {
    setView('ai-usage');
    setSelectedSystem(null);
  };

  const switchToEvents = () => {
    setView('events');
    setSelectedSystem(null);
  };

  // Permission checks for UI visibility
  const canViewSettings = hasPermission(currentUser, 'systems:view') ||
    hasPermission(currentUser, 'ai_config:view') ||
    hasPermission(currentUser, 'users:manage') ||
    hasPermission(currentUser, 'audit:view') ||
    hasPermission(currentUser, 'api_keys:manage');
  const canViewAiUsage = hasPermission(currentUser, 'ai_usage:view');

  // Role label for display
  const roleLabel = currentUser?.role?.replace(/_/g, ' ') ?? '';

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <h1>
            <span>Log</span>Sentinel AI
            <span className="version-tag">v0.8.8-beta</span>
          </h1>
          <nav className="header-nav" role="tablist" aria-label="Main navigation">
            <button
              className={`nav-tab${view === 'dashboard' ? ' active' : ''}`}
              onClick={switchToDashboard}
              role="tab"
              aria-selected={view === 'dashboard'}
            >
              Dashboard
            </button>
            <button
              className={`nav-tab${view === 'events' ? ' active' : ''}`}
              onClick={switchToEvents}
              role="tab"
              aria-selected={view === 'events'}
            >
              Events
            </button>
            {canViewAiUsage && (
              <button
                className={`nav-tab${view === 'ai-usage' ? ' active' : ''}`}
                onClick={switchToAiUsage}
                role="tab"
                aria-selected={view === 'ai-usage'}
              >
                AI Usage
              </button>
            )}
            {canViewSettings && (
              <button
                className={`nav-tab${view === 'settings' ? ' active' : ''}`}
                onClick={switchToSettings}
                role="tab"
                aria-selected={view === 'settings'}
              >
                Settings
              </button>
            )}
          </nav>
        </div>
        <div className="header-actions">
          {view === 'dashboard' && lastRefreshed && (
            <span className="last-refreshed" aria-live="polite">
              {refreshing ? 'Refreshing…' : `Updated ${String(lastRefreshed.getHours()).padStart(2,'0')}:${String(lastRefreshed.getMinutes()).padStart(2,'0')}:${String(lastRefreshed.getSeconds()).padStart(2,'0')}`}
            </span>
          )}
          {view === 'dashboard' && (
            <button
              className="btn btn-sm btn-outline"
              onClick={() => loadSystems(true)}
              disabled={refreshing}
              aria-label="Refresh dashboard data"
            >
              {refreshing ? '↻' : 'Refresh'}
            </button>
          )}
          {currentUser && (
            <span className="user-info" style={{ fontSize: '0.85em', color: 'var(--muted)', marginRight: '0.5rem' }}>
              {currentUser.display_name || currentUser.username}
              <span style={{ fontSize: '0.75em', opacity: 0.7, marginLeft: '0.3rem' }}>
                ({roleLabel})
              </span>
            </span>
          )}
          <button className="btn btn-sm btn-outline" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </header>

      {error && <div className="error-msg" role="alert">{error}</div>}

      {view === 'events' ? (
        <EventExplorerView onAuthError={handleLogout} />
      ) : view === 'ai-usage' ? (
        <LlmUsageView onAuthError={handleLogout} />
      ) : view === 'settings' ? (
        <SettingsView onAuthError={handleLogout} currentUser={currentUser} initialTab={settingsInitialTab} onTabConsumed={() => setSettingsInitialTab(undefined)} />
      ) : selectedSystem ? (
        <DrillDown
          system={selectedSystem}
          onBack={() => setSelectedSystem(null)}
          onAuthError={handleLogout}
          currentUser={currentUser}
          onRefreshSystem={() => loadSystems()}
        />
      ) : (
        <>
          {loading && systems.length === 0 && (
            <div className="loading" aria-live="polite">
              <div className="spinner" />
              Loading systems…
            </div>
          )}

          {!loading && systems.length === 0 && (
            <div className="empty-state">
              <h3>No monitored systems</h3>
              <p>
                Get started by going to{' '}
                <button className="link-button" onClick={switchToSettings}>
                  Settings
                </button>{' '}
                to create your first monitored system and log source.
              </p>
            </div>
          )}

          {discoveryCount > 0 && (
            <div className="discovery-banner" role="status">
              <span>
                <strong>{discoveryCount}</strong> new log source{discoveryCount !== 1 ? 's' : ''} detected
              </span>
              <button className="btn btn-sm" onClick={() => { setSettingsInitialTab('discovery'); setView('settings'); }}>
                Review Suggestions
              </button>
            </div>
          )}

          <div className="system-grid" role="list">
            {systems.map((s) => (
              <SystemCard
                key={s.id}
                system={s}
                onClick={() => setSelectedSystem(s)}
              />
            ))}
          </div>

          {systems.length > 0 && hasPermission(currentUser, 'rag:use') && (
            <AskAiPanel
              systems={systems}
              onAuthError={handleLogout}
            />
          )}
        </>
      )}
    </div>
  );
}
