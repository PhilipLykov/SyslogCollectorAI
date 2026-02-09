import { useEffect, useState, useCallback } from 'react';
import {
  type AiConfigResponse, fetchAiConfig, updateAiConfig,
  type AiPromptsResponse, fetchAiPrompts, updateAiPrompts,
  type AckConfigResponse, fetchAckConfig, updateAckConfig,
} from '../api';

interface AiConfigSectionProps {
  onAuthError: () => void;
}

/**
 * AI Configuration panel — lets the admin set the OpenAI-compatible model,
 * base URL, API key, and custom system prompts at runtime
 * (stored in the DB, no restart needed).
 */
export function AiConfigSection({ onAuthError }: AiConfigSectionProps) {
  const [config, setConfig] = useState<AiConfigResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Form fields — model / connection
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKeyField, setShowKeyField] = useState(false);

  // Prompt state
  const [promptsData, setPromptsData] = useState<AiPromptsResponse | null>(null);
  const [scoringPrompt, setScoringPrompt] = useState('');
  const [metaPrompt, setMetaPrompt] = useState('');
  const [showScoringPrompt, setShowScoringPrompt] = useState(false);
  const [showMetaPrompt, setShowMetaPrompt] = useState(false);
  const [savingPrompts, setSavingPrompts] = useState(false);
  const [promptSuccess, setPromptSuccess] = useState('');
  const [promptError, setPromptError] = useState('');

  // Ack config state
  const [ackConfig, setAckConfig] = useState<AckConfigResponse | null>(null);
  const [ackMode, setAckMode] = useState<'skip' | 'context_only'>('context_only');
  const [ackPrompt, setAckPrompt] = useState('');
  const [showAckConfig, setShowAckConfig] = useState(false);
  const [savingAck, setSavingAck] = useState(false);
  const [ackSuccess, setAckSuccess] = useState('');
  const [ackError, setAckError] = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const [data, prompts, ack] = await Promise.all([
        fetchAiConfig(),
        fetchAiPrompts(),
        fetchAckConfig(),
      ]);
      setConfig(data);
      setModel(data.model);
      setBaseUrl(data.base_url);
      setApiKey('');
      setShowKeyField(false);
      setPromptsData(prompts);
      setScoringPrompt(prompts.scoring_system_prompt ?? prompts.default_scoring_system_prompt);
      setMetaPrompt(prompts.meta_system_prompt ?? prompts.default_meta_system_prompt);
      setAckConfig(ack);
      setAckMode(ack.mode);
      setAckPrompt(ack.prompt);
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

      {/* ── System Prompts ─────────────────────────────────── */}
      <div className="ai-prompts-section">
        <h3>LLM System Prompts</h3>
        <p className="ai-config-desc">
          Customize the instructions sent to the LLM for event scoring and meta-analysis.
          The system description of each monitored system is always included as a separate
          <strong> SYSTEM SPECIFICATION</strong> block in the user content.
          Leave empty or click "Reset to Default" to use the built-in prompt.
        </p>

        {promptError && (
          <div className="error-msg" role="alert">
            {promptError}
            <button className="error-dismiss" onClick={() => setPromptError('')} aria-label="Dismiss error">&times;</button>
          </div>
        )}
        {promptSuccess && (
          <div className="success-msg" role="status">
            {promptSuccess}
            <button className="error-dismiss" onClick={() => setPromptSuccess('')} aria-label="Dismiss">&times;</button>
          </div>
        )}

        {/* Scoring Prompt */}
        <div className="prompt-block">
          <button
            type="button"
            className="prompt-toggle"
            onClick={() => setShowScoringPrompt((v) => !v)}
          >
            <span className={`prompt-chevron${showScoringPrompt ? ' open' : ''}`}>&#9654;</span>
            Scoring System Prompt
            {promptsData?.scoring_is_custom && <span className="prompt-custom-badge">custom</span>}
          </button>

          {showScoringPrompt && (
            <div className="prompt-editor">
              <textarea
                className="prompt-textarea"
                value={scoringPrompt}
                onChange={(e) => setScoringPrompt(e.target.value)}
                rows={12}
                spellCheck={false}
              />
              <div className="prompt-editor-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={savingPrompts}
                  onClick={async () => {
                    setSavingPrompts(true);
                    setPromptError('');
                    setPromptSuccess('');
                    try {
                      const isDefault = scoringPrompt.trim() === promptsData?.default_scoring_system_prompt.trim();
                      const updated = await updateAiPrompts({
                        scoring_system_prompt: isDefault ? null : scoringPrompt,
                      });
                      setPromptsData(updated);
                      setScoringPrompt(updated.scoring_system_prompt ?? updated.default_scoring_system_prompt);
                      setPromptSuccess('Scoring prompt saved. Applies to the next pipeline run.');
                    } catch (err: unknown) {
                      const msg = err instanceof Error ? err.message : String(err);
                      if (msg.includes('Authentication')) { onAuthError(); return; }
                      setPromptError(msg);
                    } finally {
                      setSavingPrompts(false);
                    }
                  }}
                >
                  {savingPrompts ? 'Saving…' : 'Save Scoring Prompt'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  disabled={savingPrompts}
                  onClick={async () => {
                    if (!window.confirm('Reset the scoring prompt to the built-in default?')) return;
                    setSavingPrompts(true);
                    setPromptError('');
                    setPromptSuccess('');
                    try {
                      const updated = await updateAiPrompts({ scoring_system_prompt: null });
                      setPromptsData(updated);
                      setScoringPrompt(updated.default_scoring_system_prompt);
                      setPromptSuccess('Scoring prompt reset to default.');
                    } catch (err: unknown) {
                      const msg = err instanceof Error ? err.message : String(err);
                      if (msg.includes('Authentication')) { onAuthError(); return; }
                      setPromptError(msg);
                    } finally {
                      setSavingPrompts(false);
                    }
                  }}
                >
                  Reset to Default
                </button>
              </div>
              <span className="form-hint">
                This prompt is sent as the <code>system</code> message to the LLM when scoring individual events.
                The user message will include the system specification, log sources, and events.
              </span>
            </div>
          )}
        </div>

        {/* Meta-Analysis Prompt */}
        <div className="prompt-block">
          <button
            type="button"
            className="prompt-toggle"
            onClick={() => setShowMetaPrompt((v) => !v)}
          >
            <span className={`prompt-chevron${showMetaPrompt ? ' open' : ''}`}>&#9654;</span>
            Meta-Analysis System Prompt
            {promptsData?.meta_is_custom && <span className="prompt-custom-badge">custom</span>}
          </button>

          {showMetaPrompt && (
            <div className="prompt-editor">
              <textarea
                className="prompt-textarea"
                value={metaPrompt}
                onChange={(e) => setMetaPrompt(e.target.value)}
                rows={16}
                spellCheck={false}
              />
              <div className="prompt-editor-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={savingPrompts}
                  onClick={async () => {
                    setSavingPrompts(true);
                    setPromptError('');
                    setPromptSuccess('');
                    try {
                      const isDefault = metaPrompt.trim() === promptsData?.default_meta_system_prompt.trim();
                      const updated = await updateAiPrompts({
                        meta_system_prompt: isDefault ? null : metaPrompt,
                      });
                      setPromptsData(updated);
                      setMetaPrompt(updated.meta_system_prompt ?? updated.default_meta_system_prompt);
                      setPromptSuccess('Meta-analysis prompt saved. Applies to the next pipeline run.');
                    } catch (err: unknown) {
                      const msg = err instanceof Error ? err.message : String(err);
                      if (msg.includes('Authentication')) { onAuthError(); return; }
                      setPromptError(msg);
                    } finally {
                      setSavingPrompts(false);
                    }
                  }}
                >
                  {savingPrompts ? 'Saving…' : 'Save Meta Prompt'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  disabled={savingPrompts}
                  onClick={async () => {
                    if (!window.confirm('Reset the meta-analysis prompt to the built-in default?')) return;
                    setSavingPrompts(true);
                    setPromptError('');
                    setPromptSuccess('');
                    try {
                      const updated = await updateAiPrompts({ meta_system_prompt: null });
                      setPromptsData(updated);
                      setMetaPrompt(updated.default_meta_system_prompt);
                      setPromptSuccess('Meta-analysis prompt reset to default.');
                    } catch (err: unknown) {
                      const msg = err instanceof Error ? err.message : String(err);
                      if (msg.includes('Authentication')) { onAuthError(); return; }
                      setPromptError(msg);
                    } finally {
                      setSavingPrompts(false);
                    }
                  }}
                >
                  Reset to Default
                </button>
              </div>
              <span className="form-hint">
                This prompt is sent as the <code>system</code> message during meta-analysis (window-level).
                The user message includes the system specification, previous context, open findings, and current window events.
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Event Acknowledgement Configuration ─────────── */}
      <div className="ai-prompts-section">
        <h3>Event Acknowledgement Behaviour</h3>
        <p className="ai-config-desc">
          Configure how the LLM handles events that have been acknowledged by a user.
          Acknowledged events are always excluded from per-event scoring.
          The setting below controls how they appear in <strong>meta-analysis</strong>.
        </p>

        {ackError && (
          <div className="error-msg" role="alert">
            {ackError}
            <button className="error-dismiss" onClick={() => setAckError('')} aria-label="Dismiss">&times;</button>
          </div>
        )}
        {ackSuccess && (
          <div className="success-msg" role="status">
            {ackSuccess}
            <button className="error-dismiss" onClick={() => setAckSuccess('')} aria-label="Dismiss">&times;</button>
          </div>
        )}

        <div className="prompt-block">
          <button
            type="button"
            className="prompt-toggle"
            onClick={() => setShowAckConfig((v) => !v)}
          >
            <span className={`prompt-chevron${showAckConfig ? ' open' : ''}`}>&#9654;</span>
            Acknowledgement Settings
          </button>

          {showAckConfig && (
            <div className="prompt-editor">
              <div className="form-group" style={{ marginBottom: 16 }}>
                <label htmlFor="ack-mode">Meta-analysis mode for acknowledged events</label>
                <select
                  id="ack-mode"
                  value={ackMode}
                  onChange={(e) => setAckMode(e.target.value as 'skip' | 'context_only')}
                  style={{ maxWidth: 320 }}
                >
                  <option value="context_only">Context only (include with ack prompt)</option>
                  <option value="skip">Skip entirely (exclude from meta-analysis)</option>
                </select>
                <span className="form-hint">
                  <strong>Context only</strong>: Acknowledged events are sent to the LLM with a special note (see prompt below),
                  so the LLM can use them for pattern recognition but won't raise new findings.
                  <br />
                  <strong>Skip</strong>: Acknowledged events are completely excluded from meta-analysis.
                </span>
              </div>

              {ackMode === 'context_only' && (
                <div className="form-group" style={{ marginBottom: 16 }}>
                  <label htmlFor="ack-prompt">Ack prompt (prepended to acknowledged events)</label>
                  <textarea
                    id="ack-prompt"
                    className="prompt-textarea"
                    value={ackPrompt}
                    onChange={(e) => setAckPrompt(e.target.value)}
                    rows={3}
                    spellCheck={false}
                  />
                  <span className="form-hint">
                    This text is prepended to each acknowledged event in the LLM context
                    (as <code>[ACK] event message — {'<'}your prompt{'>'}</code>).
                  </span>
                </div>
              )}

              <div className="prompt-editor-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={savingAck}
                  onClick={async () => {
                    setSavingAck(true);
                    setAckError('');
                    setAckSuccess('');
                    try {
                      const payload: { mode?: 'skip' | 'context_only'; prompt?: string } = {};
                      if (ackMode !== ackConfig?.mode) payload.mode = ackMode;
                      if (ackPrompt !== ackConfig?.prompt) payload.prompt = ackPrompt;
                      if (!Object.keys(payload).length) {
                        setAckSuccess('No changes to save.');
                        setSavingAck(false);
                        return;
                      }
                      const updated = await updateAckConfig(payload);
                      setAckConfig(updated);
                      setAckMode(updated.mode);
                      setAckPrompt(updated.prompt);
                      setAckSuccess('Acknowledgement settings saved.');
                    } catch (err: unknown) {
                      const msg = err instanceof Error ? err.message : String(err);
                      if (msg.includes('Authentication')) { onAuthError(); return; }
                      setAckError(msg);
                    } finally {
                      setSavingAck(false);
                    }
                  }}
                >
                  {savingAck ? 'Saving...' : 'Save Settings'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  disabled={savingAck}
                  onClick={async () => {
                    if (!window.confirm('Reset acknowledgement settings to defaults?')) return;
                    setSavingAck(true);
                    setAckError('');
                    setAckSuccess('');
                    try {
                      const updated = await updateAckConfig({ mode: 'context_only', prompt: '' });
                      setAckConfig(updated);
                      setAckMode(updated.mode);
                      setAckPrompt(updated.prompt);
                      setAckSuccess('Settings reset to defaults.');
                    } catch (err: unknown) {
                      const msg = err instanceof Error ? err.message : String(err);
                      if (msg.includes('Authentication')) { onAuthError(); return; }
                      setAckError(msg);
                    } finally {
                      setSavingAck(false);
                    }
                  }}
                >
                  Reset to Default
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
