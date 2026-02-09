import { useEffect, useState, useCallback } from 'react';
import { type AiConfigResponse, fetchAiConfig, updateAiConfig } from '../api';

interface AiConfigSectionProps {
  onAuthError: () => void;
}

/**
 * AI Configuration panel — lets the admin set the OpenAI-compatible model,
 * base URL, and API key at runtime (stored in the DB, no restart needed).
 */
export function AiConfigSection({ onAuthError }: AiConfigSectionProps) {
  const [config, setConfig] = useState<AiConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Form fields
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKeyField, setShowKeyField] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const data = await fetchAiConfig();
      setConfig(data);
      setModel(data.model);
      setBaseUrl(data.base_url);
      setApiKey('');
      setShowKeyField(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [onAuthError]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setSaving(true);

    try {
      const payload: Record<string, string> = {};
      if (model !== config?.model) payload.model = model;
      if (baseUrl !== config?.base_url) payload.base_url = baseUrl;
      if (showKeyField && apiKey.trim() !== '') payload.api_key = apiKey.trim();

      if (Object.keys(payload).length === 0) {
        setSuccess('No changes to save.');
        setSaving(false);
        return;
      }

      const updated = await updateAiConfig(payload);
      setConfig(updated);
      setApiKey('');
      setShowKeyField(false);
      setSuccess('AI configuration saved successfully. Changes take effect on the next pipeline run.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleClearKey = async () => {
    if (!window.confirm('Clear the API key stored in the database? The system will fall back to the environment variable if set.')) return;
    setError('');
    setSuccess('');
    setSaving(true);
    try {
      const updated = await updateAiConfig({ api_key: '' });
      setConfig(updated);
      setApiKey('');
      setShowKeyField(false);
      setSuccess('Database API key cleared. Using environment variable if available.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="ai-config-section">
        <div className="settings-loading"><div className="spinner" /> Loading AI configuration…</div>
      </div>
    );
  }

  return (
    <div className="ai-config-section">
      <div className="ai-config-header">
        <h3>AI Model Configuration</h3>
        <p className="ai-config-desc">
          Configure the OpenAI-compatible LLM used for event scoring and meta-analysis.
          Changes take effect on the next pipeline cycle (no restart required).
        </p>
      </div>

      {error && (
        <div className="error-msg" role="alert">
          {error}
          <button className="error-dismiss" onClick={() => setError('')} aria-label="Dismiss error">&times;</button>
        </div>
      )}
      {success && (
        <div className="success-msg" role="status">
          {success}
          <button className="error-dismiss" onClick={() => setSuccess('')} aria-label="Dismiss">&times;</button>
        </div>
      )}

      <form className="ai-config-form" onSubmit={handleSave}>
        {/* Model */}
        <div className="form-group">
          <label htmlFor="ai-model">Model</label>
          <input
            id="ai-model"
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="e.g. gpt-4o-mini"
            required
            autoComplete="off"
          />
          <span className="form-hint">
            OpenAI model name (e.g. gpt-4o-mini, gpt-4o, gpt-3.5-turbo, o3-mini)
          </span>
        </div>

        {/* Base URL */}
        <div className="form-group">
          <label htmlFor="ai-base-url">API Base URL</label>
          <input
            id="ai-base-url"
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            required
            autoComplete="off"
          />
          <span className="form-hint">
            OpenAI-compatible API endpoint. Change this for Azure OpenAI, local models, or proxies.
          </span>
        </div>

        {/* API Key */}
        <div className="form-group">
          <label>API Key</label>
          <div className="ai-key-status">
            {config?.api_key_set ? (
              <>
                <span className="ai-key-badge set">Key configured</span>
                <code className="ai-key-hint">{config.api_key_hint}</code>
                <span className="ai-key-source">
                  Source: <strong>{config.api_key_source}</strong>
                </span>
              </>
            ) : (
              <span className="ai-key-badge not-set">No API key configured</span>
            )}
          </div>

          {!showKeyField ? (
            <div className="ai-key-actions">
              <button
                type="button"
                className="btn btn-sm btn-outline"
                onClick={() => setShowKeyField(true)}
              >
                {config?.api_key_set ? 'Change API Key' : 'Set API Key'}
              </button>
              {config?.api_key_source === 'database' && (
                <button
                  type="button"
                  className="btn btn-sm btn-danger-outline"
                  onClick={handleClearKey}
                  disabled={saving}
                >
                  Clear DB Key
                </button>
              )}
            </div>
          ) : (
            <div className="ai-key-input-group">
              <input
                id="ai-api-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                autoComplete="new-password"
              />
              <button
                type="button"
                className="btn btn-sm btn-outline"
                onClick={() => { setShowKeyField(false); setApiKey(''); }}
              >
                Cancel
              </button>
            </div>
          )}
          <span className="form-hint">
            The API key is stored securely in the database. It is never displayed in full after saving.
          </span>
        </div>

        <div className="ai-config-actions">
          <button type="submit" className="btn" disabled={saving}>
            {saving ? 'Saving…' : 'Save Configuration'}
          </button>
          <button type="button" className="btn btn-outline" onClick={load} disabled={saving}>
            Reset
          </button>
        </div>
      </form>
    </div>
  );
}
