import { useEffect, useState, useCallback, useRef } from 'react';
import { type DashboardSystem, fetchDashboardSystems, getStoredApiKey, setApiKey } from './api';
import { SystemCard } from './components/SystemCard';
import { DrillDown } from './components/DrillDown';
import { LoginForm } from './components/LoginForm';
import { SettingsView } from './components/SettingsView';
import { LlmUsageView } from './components/LlmUsageView';
import { EventExplorerView } from './components/EventExplorerView';
import './index.css';

type View = 'dashboard' | 'settings' | 'ai-usage' | 'events';

export default function App() {
  const [authenticated, setAuthenticated] = useState(!!getStoredApiKey());
  const [view, setView] = useState<View>('dashboard');
  const [systems, setSystems] = useState<DashboardSystem[]>([]);
  const [selectedSystem, setSelectedSystem] = useState<DashboardSystem | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const fetchId = useRef(0); // Prevent stale fetch responses overwriting fresh data

  const loadSystems = useCallback(async (isManual = false) => {
    const id = ++fetchId.current;

    // Use functional setter to check if we need the full loading indicator
    // (avoids depending on systems.length in the useCallback deps)
    setSystems((prev) => {
      if (prev.length === 0) setLoading(true);
      return prev;
    });
    if (isManual) {
      setRefreshing(true);
    }
    setError('');

    try {
      const data = await fetchDashboardSystems();

      // Prevent stale response from overwriting newer data
      if (id !== fetchId.current) return;

      setSystems(data);
      setLastRefreshed(new Date());

      // Keep the selected system in sync with refreshed data
      setSelectedSystem((prev) => {
        if (!prev) return null;
        const updated = data.find((s) => s.id === prev.id);
        return updated ?? null; // deselect if system was deleted
      });
    } catch (err: unknown) {
      if (id !== fetchId.current) return;
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Authentication')) {
        setAuthenticated(false);
        setApiKey('');
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
      // Auto-refresh every 30 seconds
      const interval = setInterval(() => loadSystems(), 30_000);
      return () => clearInterval(interval);
    }
  }, [authenticated, loadSystems]);

  const handleLogin = () => {
    setAuthenticated(true);
  };

  // Memoized so child views using onAuthError in useCallback deps
  // don't needlessly re-fetch when App re-renders (e.g. from auto-refresh).
  const handleLogout = useCallback(() => {
    setApiKey('');
    setAuthenticated(false);
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

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <h1>
            <span>Syslog</span>CollectorAI
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
            <button
              className={`nav-tab${view === 'ai-usage' ? ' active' : ''}`}
              onClick={switchToAiUsage}
              role="tab"
              aria-selected={view === 'ai-usage'}
            >
              AI Usage
            </button>
            <button
              className={`nav-tab${view === 'settings' ? ' active' : ''}`}
              onClick={switchToSettings}
              role="tab"
              aria-selected={view === 'settings'}
            >
              Settings
            </button>
          </nav>
        </div>
        <div className="header-actions">
          {view === 'dashboard' && lastRefreshed && (
            <span className="last-refreshed" aria-live="polite">
              {refreshing ? 'Refreshing…' : `Updated ${lastRefreshed.toLocaleTimeString()}`}
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
        <SettingsView onAuthError={handleLogout} />
      ) : selectedSystem ? (
        <DrillDown
          system={selectedSystem}
          onBack={() => setSelectedSystem(null)}
          onAuthError={handleLogout}
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

          <div className="system-grid" role="list">
            {systems.map((s) => (
              <SystemCard
                key={s.id}
                system={s}
                onClick={() => setSelectedSystem(s)}
                onAuthError={handleLogout}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
