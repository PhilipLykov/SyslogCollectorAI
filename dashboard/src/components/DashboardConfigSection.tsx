import { useEffect, useState, useCallback } from 'react';
import { NumericInput } from './NumericInput';
import {
  type DashboardConfig,
  type DashboardConfigResponse,
  fetchDashboardConfig,
  updateDashboardConfig,
} from '../api';

interface DashboardConfigSectionProps {
  onAuthError: () => void;
}

/**
 * Dashboard configuration panel — lets the admin configure the score
 * display window (how many days of analysis the dashboard score bars
 * represent).  Stored in the DB via the app_config table.
 */
export function DashboardConfigSection({ onAuthError }: DashboardConfigSectionProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [config, setConfig] = useState<DashboardConfig | null>(null);
  const [defaults, setDefaults] = useState<DashboardConfig | null>(null);

  // Local form state
  const [windowDays, setWindowDays] = useState(7);

  const loadConfig = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const resp: DashboardConfigResponse = await fetchDashboardConfig();
      setConfig(resp.config);
      setDefaults(resp.defaults);
      setWindowDays(resp.config.score_display_window_days);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) {
        onAuthError();
        return;
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [onAuthError]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const handleSave = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const resp = await updateDashboardConfig({
        score_display_window_days: windowDays,
      });
      setConfig(resp.config);
      setSuccess('Dashboard configuration saved successfully.');
      setTimeout(() => setSuccess(''), 4000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) {
        onAuthError();
        return;
      }
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    if (defaults) {
      setWindowDays(defaults.score_display_window_days);
    }
  };

  const isDirty = config ? windowDays !== config.score_display_window_days : false;

  if (loading) {
    return (
      <div className="settings-loading">
        <div className="spinner" />
        Loading dashboard configuration…
      </div>
    );
  }

  return (
    <section className="config-section">
      <h3>Dashboard Display</h3>
      <p className="config-section-desc">
        Configure how the dashboard displays system health scores. The score display window
        determines how many days of analysis data the score bars represent.
      </p>

      {error && (
        <div className="error-msg" role="alert">
          {error}
          <button className="error-dismiss" onClick={() => setError('')} aria-label="Dismiss error">
            &times;
          </button>
        </div>
      )}
      {success && (
        <div className="success-msg" role="status">
          {success}
        </div>
      )}

      <div className="config-form-group">
        <label className="config-label" htmlFor="score-window-days">
          Score display window (days)
          <span className="config-hint">
            How many days of scoring history the dashboard score bars reflect.
            Larger values give a more stable overview; smaller values respond faster to changes.
            Range: 1–90 days. Default: {defaults?.score_display_window_days ?? 7}.
          </span>
        </label>
        <div className="config-input-row">
          <NumericInput
            value={windowDays}
            onChange={setWindowDays}
            min={1}
            max={90}
            className="config-input config-input-short"
            disabled={saving}
          />
          <span className="config-unit">days</span>
        </div>
      </div>

      <div className="config-actions">
        <button
          className="btn btn-primary"
          onClick={handleSave}
          disabled={saving || !isDirty}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          className="btn btn-outline"
          onClick={handleReset}
          disabled={saving}
          title="Reset to default value"
        >
          Reset to Default
        </button>
      </div>
    </section>
  );
}
