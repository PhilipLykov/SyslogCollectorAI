import { useEffect, useState, useCallback } from 'react';
import { NumericInput } from './NumericInput';
import {
  type AiConfigResponse, fetchAiConfig, updateAiConfig,
  type AiPromptsResponse, fetchAiPrompts, updateAiPrompts,
  type AckConfigResponse, fetchAckConfig, updateAckConfig,
  type TokenOptimizationConfig, type TokenOptResponse,
  fetchTokenOptConfig, updateTokenOptConfig, invalidateScoreCache,
  type MetaAnalysisConfig, type MetaAnalysisConfigResponse,
  fetchMetaAnalysisConfig, updateMetaAnalysisConfig,
  type CriterionGuidelinesResponse,
  fetchCriterionGuidelines, updateCriterionGuidelines,
  type PipelineConfig, type PipelineConfigResponse,
  fetchPipelineConfig, updatePipelineConfig,
  type TaskModelConfig, type TaskModelConfigResponse,
  fetchTaskModelConfig, updateTaskModelConfig,
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
  const [ragPrompt, setRagPrompt] = useState('');
  const [showScoringPrompt, setShowScoringPrompt] = useState(false);
  const [showMetaPrompt, setShowMetaPrompt] = useState(false);
  const [showRagPrompt, setShowRagPrompt] = useState(false);
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

  // Token optimization state
  const [tokenOpt, setTokenOpt] = useState<TokenOptResponse | null>(null);
  const [tokCfg, setTokCfg] = useState<TokenOptimizationConfig | null>(null);
  const [showTokenOpt, setShowTokenOpt] = useState(false);
  const [savingTok, setSavingTok] = useState(false);
  const [tokSuccess, setTokSuccess] = useState('');
  const [tokError, setTokError] = useState('');
  const [invalidating, setInvalidating] = useState(false);

  // Meta-analysis tuning state
  const [metaAnalysis, setMetaAnalysis] = useState<MetaAnalysisConfigResponse | null>(null);
  const [metaCfg, setMetaCfg] = useState<MetaAnalysisConfig | null>(null);
  const [showMetaAnalysis, setShowMetaAnalysis] = useState(false);
  const [savingMeta, setSavingMeta] = useState(false);
  const [metaSuccess, setMetaSuccess] = useState('');
  const [metaError, setMetaError] = useState('');

  // Pipeline config state
  const [pipelineCfgResp, setPipelineCfgResp] = useState<PipelineConfigResponse | null>(null);
  const [pipeCfg, setPipeCfg] = useState<PipelineConfig | null>(null);
  const [showPipeline, setShowPipeline] = useState(false);
  const [savingPipe, setSavingPipe] = useState(false);
  const [pipeSuccess, setPipeSuccess] = useState('');
  const [pipeError, setPipeError] = useState('');

  // Per-task model config state
  const [, setTaskModelResp] = useState<TaskModelConfigResponse | null>(null);
  const [taskModelCfg, setTaskModelCfg] = useState<TaskModelConfig | null>(null);
  const [showTaskModel, setShowTaskModel] = useState(false);
  const [savingTaskModel, setSavingTaskModel] = useState(false);
  const [taskModelSuccess, setTaskModelSuccess] = useState('');
  const [taskModelError, setTaskModelError] = useState('');

  // Criterion guidelines state
  const [guidelinesData, setGuidelinesData] = useState<CriterionGuidelinesResponse | null>(null);
  const [guideEdits, setGuideEdits] = useState<Record<string, string>>({});
  const [showGuidelines, setShowGuidelines] = useState(false);
  const [expandedCriterion, setExpandedCriterion] = useState<string | null>(null);
  const [savingGuide, setSavingGuide] = useState(false);
  const [guideSuccess, setGuideSuccess] = useState('');
  const [guideError, setGuideError] = useState('');
  const [showPromptPreview, setShowPromptPreview] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const [data, prompts, ack, tok, meta, guides, pipe, taskModel] = await Promise.all([
        fetchAiConfig(),
        fetchAiPrompts(),
        fetchAckConfig(),
        fetchTokenOptConfig(),
        fetchMetaAnalysisConfig(),
        fetchCriterionGuidelines(),
        fetchPipelineConfig(),
        fetchTaskModelConfig(),
      ]);
      setConfig(data);
      setModel(data.model);
      setBaseUrl(data.base_url);
      setApiKey('');
      setShowKeyField(false);
      setPromptsData(prompts);
      setScoringPrompt(prompts.scoring_system_prompt ?? prompts.default_scoring_system_prompt);
      setMetaPrompt(prompts.meta_system_prompt ?? prompts.default_meta_system_prompt);
      setRagPrompt(prompts.rag_system_prompt ?? prompts.default_rag_system_prompt);
      setAckConfig(ack);
      setAckMode(ack.mode);
      setAckPrompt(ack.prompt);
      setTokenOpt(tok);
      setTokCfg(tok.config);
      setMetaAnalysis(meta);
      setMetaCfg(meta.config);
      setPipelineCfgResp(pipe);
      setPipeCfg(pipe.config);
      setTaskModelResp(taskModel);
      setTaskModelCfg(taskModel.config);
      setGuidelinesData(guides);
      // Initialize edits from current values
      const edits: Record<string, string> = {};
      for (const [slug, info] of Object.entries(guides.guidelines)) {
        edits[slug] = info.current;
      }
      setGuideEdits(edits);
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

        {/* RAG / Ask Question Prompt */}
        <div className="prompt-block">
          <button
            type="button"
            className="prompt-toggle"
            onClick={() => setShowRagPrompt((v) => !v)}
          >
            <span className={`prompt-chevron${showRagPrompt ? ' open' : ''}`}>&#9654;</span>
            Ask Question (RAG) System Prompt
            {promptsData?.rag_is_custom && <span className="prompt-custom-badge">custom</span>}
          </button>

          {showRagPrompt && (
            <div className="prompt-editor">
              <textarea
                className="prompt-textarea"
                value={ragPrompt}
                onChange={(e) => setRagPrompt(e.target.value)}
                rows={6}
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
                      const isDefault = ragPrompt.trim() === promptsData?.default_rag_system_prompt.trim();
                      const updated = await updateAiPrompts({
                        rag_system_prompt: isDefault ? null : ragPrompt,
                      });
                      setPromptsData(updated);
                      setRagPrompt(updated.rag_system_prompt ?? updated.default_rag_system_prompt);
                      setPromptSuccess('RAG prompt saved. Takes effect immediately for new questions.');
                    } catch (err: unknown) {
                      const msg = err instanceof Error ? err.message : String(err);
                      if (msg.includes('Authentication')) { onAuthError(); return; }
                      setPromptError(msg);
                    } finally {
                      setSavingPrompts(false);
                    }
                  }}
                >
                  {savingPrompts ? 'Saving…' : 'Save RAG Prompt'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  disabled={savingPrompts}
                  onClick={async () => {
                    if (!window.confirm('Reset the RAG prompt to the built-in default?')) return;
                    setSavingPrompts(true);
                    setPromptError('');
                    setPromptSuccess('');
                    try {
                      const updated = await updateAiPrompts({ rag_system_prompt: null });
                      setPromptsData(updated);
                      setRagPrompt(updated.default_rag_system_prompt);
                      setPromptSuccess('RAG prompt reset to default.');
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
                This prompt is sent as the <code>system</code> message when a user asks a natural-language question
                via the Ask Question feature. The user message includes context from recent meta-analysis results.
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Per-Criterion Scoring Guidelines ──────────── */}
      <div className="ai-prompts-section">
        <h3>Criterion Scoring Guidelines</h3>
        <p className="ai-config-desc">
          Each event is scored by the LLM against 6 criteria. These guidelines tell the LLM
          exactly what to look for when scoring each criterion. Edit them independently to tune
          scoring behaviour for your environment. Changes take effect on the next pipeline run.
        </p>

        {guideError && (
          <div className="error-msg" role="alert">
            {guideError}
            <button className="error-dismiss" onClick={() => setGuideError('')} aria-label="Dismiss">&times;</button>
          </div>
        )}
        {guideSuccess && (
          <div className="success-msg" role="status">
            {guideSuccess}
            <button className="error-dismiss" onClick={() => setGuideSuccess('')} aria-label="Dismiss">&times;</button>
          </div>
        )}

        <div className="prompt-block">
          <button
            type="button"
            className="prompt-toggle"
            onClick={() => setShowGuidelines((v) => !v)}
          >
            <span className={`prompt-chevron${showGuidelines ? ' open' : ''}`}>&#9654;</span>
            Scoring Guidelines per Criterion
            {guidelinesData && Object.values(guidelinesData.guidelines).some((g) => g.is_custom) && (
              <span className="prompt-custom-badge">custom</span>
            )}
          </button>

          {showGuidelines && guidelinesData && (
            <div className="prompt-editor tok-opt-editor">
              <span className="form-hint" style={{ marginBottom: 12, display: 'block' }}>
                The LLM receives a combined prompt that includes all 6 criterion guidelines below.
                If you also set a custom <strong>Scoring System Prompt</strong> above, it overrides
                these guidelines entirely (advanced use).
              </span>

              {Object.entries(guidelinesData.guidelines).map(([slug, info]) => {
                const CRITERION_LABELS: Record<string, string> = {
                  it_security: 'IT Security',
                  performance_degradation: 'Performance Degradation',
                  failure_prediction: 'Failure Prediction',
                  anomaly: 'Anomaly / Unusual Patterns',
                  compliance_audit: 'Compliance / Audit',
                  operational_risk: 'Operational Risk',
                };
                const isExpanded = expandedCriterion === slug;
                return (
                  <fieldset key={slug} className="tok-opt-group">
                    <legend
                      style={{ cursor: 'pointer', userSelect: 'none' }}
                      onClick={() => setExpandedCriterion(isExpanded ? null : slug)}
                    >
                      <span className={`prompt-chevron${isExpanded ? ' open' : ''}`} style={{ fontSize: '0.7em', marginRight: 6 }}>&#9654;</span>
                      {CRITERION_LABELS[slug] ?? slug}
                      {info.is_custom && <span className="prompt-custom-badge" style={{ marginLeft: 8 }}>custom</span>}
                    </legend>

                    {isExpanded && (
                      <div style={{ marginTop: 8 }}>
                        <textarea
                          className="prompt-textarea"
                          value={guideEdits[slug] ?? info.current}
                          onChange={(e) => setGuideEdits((prev) => ({ ...prev, [slug]: e.target.value }))}
                          rows={14}
                          spellCheck={false}
                        />
                        <div className="prompt-editor-actions" style={{ marginTop: 6 }}>
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={savingGuide}
                            onClick={async () => {
                              setSavingGuide(true);
                              setGuideError('');
                              setGuideSuccess('');
                              try {
                                const val = guideEdits[slug] ?? '';
                                const isDefault = val.trim() === info.default_value.trim();
                                const updated = await updateCriterionGuidelines({
                                  [slug]: isDefault ? null : val,
                                });
                                setGuidelinesData(updated);
                                const newEdits: Record<string, string> = {};
                                for (const [s, g] of Object.entries(updated.guidelines)) {
                                  newEdits[s] = g.current;
                                }
                                setGuideEdits(newEdits);
                                setGuideSuccess(`${CRITERION_LABELS[slug] ?? slug} guideline saved.`);
                              } catch (err: unknown) {
                                const msg = err instanceof Error ? err.message : String(err);
                                if (msg.includes('Authentication')) { onAuthError(); return; }
                                setGuideError(msg);
                              } finally {
                                setSavingGuide(false);
                              }
                            }}
                          >
                            {savingGuide ? 'Saving…' : 'Save'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-outline"
                            disabled={savingGuide}
                            onClick={async () => {
                              if (!window.confirm(`Reset "${CRITERION_LABELS[slug] ?? slug}" guideline to the built-in default?`)) return;
                              setSavingGuide(true);
                              setGuideError('');
                              setGuideSuccess('');
                              try {
                                const updated = await updateCriterionGuidelines({ [slug]: null });
                                setGuidelinesData(updated);
                                const newEdits: Record<string, string> = {};
                                for (const [s, g] of Object.entries(updated.guidelines)) {
                                  newEdits[s] = g.current;
                                }
                                setGuideEdits(newEdits);
                                setGuideSuccess(`${CRITERION_LABELS[slug] ?? slug} guideline reset to default.`);
                              } catch (err: unknown) {
                                const msg = err instanceof Error ? err.message : String(err);
                                if (msg.includes('Authentication')) { onAuthError(); return; }
                                setGuideError(msg);
                              } finally {
                                setSavingGuide(false);
                              }
                            }}
                          >
                            Reset to Default
                          </button>
                        </div>
                      </div>
                    )}
                  </fieldset>
                );
              })}

              {/* Save All / Reset All */}
              <div className="prompt-editor-actions" style={{ marginTop: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={savingGuide}
                  onClick={async () => {
                    setSavingGuide(true);
                    setGuideError('');
                    setGuideSuccess('');
                    try {
                      const payload: Record<string, string | null> = {};
                      for (const [slug, info] of Object.entries(guidelinesData.guidelines)) {
                        const val = guideEdits[slug] ?? '';
                        const isDefault = val.trim() === info.default_value.trim();
                        payload[slug] = isDefault ? null : val;
                      }
                      const updated = await updateCriterionGuidelines(payload);
                      setGuidelinesData(updated);
                      const newEdits: Record<string, string> = {};
                      for (const [s, g] of Object.entries(updated.guidelines)) {
                        newEdits[s] = g.current;
                      }
                      setGuideEdits(newEdits);
                      setGuideSuccess('All criterion guidelines saved.');
                    } catch (err: unknown) {
                      const msg = err instanceof Error ? err.message : String(err);
                      if (msg.includes('Authentication')) { onAuthError(); return; }
                      setGuideError(msg);
                    } finally {
                      setSavingGuide(false);
                    }
                  }}
                >
                  {savingGuide ? 'Saving…' : 'Save All Guidelines'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  disabled={savingGuide}
                  onClick={async () => {
                    if (!window.confirm('Reset ALL criterion guidelines to built-in defaults?')) return;
                    setSavingGuide(true);
                    setGuideError('');
                    setGuideSuccess('');
                    try {
                      const payload: Record<string, null> = {};
                      for (const slug of Object.keys(guidelinesData.guidelines)) {
                        payload[slug] = null;
                      }
                      const updated = await updateCriterionGuidelines(payload);
                      setGuidelinesData(updated);
                      const newEdits: Record<string, string> = {};
                      for (const [s, g] of Object.entries(updated.guidelines)) {
                        newEdits[s] = g.current;
                      }
                      setGuideEdits(newEdits);
                      setGuideSuccess('All guidelines reset to defaults.');
                    } catch (err: unknown) {
                      const msg = err instanceof Error ? err.message : String(err);
                      if (msg.includes('Authentication')) { onAuthError(); return; }
                      setGuideError(msg);
                    } finally {
                      setSavingGuide(false);
                    }
                  }}
                >
                  Reset All to Defaults
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  onClick={() => setShowPromptPreview((v) => !v)}
                >
                  {showPromptPreview ? 'Hide' : 'Preview'} Assembled Prompt
                </button>
              </div>

              {showPromptPreview && guidelinesData && (
                <div className="criterion-prompt-preview">
                  <h4 style={{ margin: '12px 0 6px' }}>Assembled Scoring Prompt (sent to LLM)</h4>
                  <pre className="criterion-prompt-preview-text">
                    {guidelinesData.assembled_prompt_preview}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Token Optimization Configuration ────────────── */}
      <div className="ai-prompts-section">
        <h3>Token Optimization</h3>
        <p className="ai-config-desc">
          Reduce LLM token usage and API costs without compromising analysis quality.
          Changes take effect on the next pipeline cycle.
        </p>

        {tokError && (
          <div className="error-msg" role="alert">
            {tokError}
            <button className="error-dismiss" onClick={() => setTokError('')} aria-label="Dismiss">&times;</button>
          </div>
        )}
        {tokSuccess && (
          <div className="success-msg" role="status">
            {tokSuccess}
            <button className="error-dismiss" onClick={() => setTokSuccess('')} aria-label="Dismiss">&times;</button>
          </div>
        )}

        <div className="prompt-block">
          <button
            type="button"
            className="prompt-toggle"
            onClick={() => setShowTokenOpt((v) => !v)}
          >
            <span className={`prompt-chevron${showTokenOpt ? ' open' : ''}`}>&#9654;</span>
            Optimization Settings
            {tokenOpt?.cache_stats && tokenOpt.cache_stats.cached_templates > 0 && (
              <span className="prompt-custom-badge">{tokenOpt.cache_stats.cached_templates} cached</span>
            )}
          </button>

          {showTokenOpt && tokCfg && (
            <div className="prompt-editor tok-opt-editor">
              {/* ── Score Cache ── */}
              <fieldset className="tok-opt-group">
                <legend>Score Cache by Template</legend>
                <span className="form-hint">
                  Reuse LLM scores for recently-scored message templates instead of re-scoring them.
                  This is the single biggest optimisation — typically saves 50–80% of scoring API calls.
                </span>
                <div className="tok-opt-row">
                  <label className="tok-opt-toggle">
                    <input
                      type="checkbox"
                      checked={tokCfg.score_cache_enabled}
                      onChange={(e) => setTokCfg({ ...tokCfg, score_cache_enabled: e.target.checked })}
                    />
                    Enable score caching
                  </label>
                </div>
                {tokCfg.score_cache_enabled && (
                  <div className="tok-opt-row">
                    <label>Cache TTL (minutes)</label>
                    <NumericInput
                      min={1} max={10080} step={1}
                      value={tokCfg.score_cache_ttl_minutes}
                      onChange={(v) => setTokCfg({ ...tokCfg, score_cache_ttl_minutes: v })}
                      style={{ width: 90 }}
                    />
                    <span className="form-hint">How long (min) to reuse cached scores before re-scoring.</span>
                  </div>
                )}
              </fieldset>

              {/* ── Severity Filter ── */}
              <fieldset className="tok-opt-group">
                <legend>Severity Pre-Filter</legend>
                <span className="form-hint">
                  Automatically score events at 0 for selected severity levels without calling the LLM.
                  Useful for noisy systems that produce many debug/info events.
                </span>
                <div className="tok-opt-row">
                  <label className="tok-opt-toggle">
                    <input
                      type="checkbox"
                      checked={tokCfg.severity_filter_enabled}
                      onChange={(e) => setTokCfg({ ...tokCfg, severity_filter_enabled: e.target.checked })}
                    />
                    Enable severity filter
                  </label>
                </div>
                {tokCfg.severity_filter_enabled && (
                  <div className="tok-opt-row">
                    <label>Skip severity levels</label>
                    <div className="tok-opt-checkboxes">
                      {['debug', 'info', 'notice', 'warning'].map((sev) => (
                        <label key={sev} className="tok-opt-toggle">
                          <input
                            type="checkbox"
                            checked={tokCfg.severity_skip_levels.includes(sev)}
                            onChange={(e) => {
                              const levels = e.target.checked
                                ? [...tokCfg.severity_skip_levels, sev]
                                : tokCfg.severity_skip_levels.filter((s) => s !== sev);
                              setTokCfg({ ...tokCfg, severity_skip_levels: levels });
                            }}
                          />
                          {sev}
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </fieldset>

              {/* ── Message Truncation ── */}
              <fieldset className="tok-opt-group">
                <legend>Message Truncation</legend>
                <span className="form-hint">
                  Limit the length of each event message sent to the LLM. Long stack traces and data dumps
                  waste tokens — the first few hundred characters usually contain the diagnostic information.
                </span>
                <div className="tok-opt-row">
                  <label>Max message length (chars)</label>
                  <NumericInput
                    min={50} max={10000} step={50}
                    value={tokCfg.message_max_length}
                    onChange={(v) => setTokCfg({ ...tokCfg, message_max_length: v })}
                    style={{ width: 90 }}
                  />
                </div>
              </fieldset>

              {/* ── Batch Size ── */}
              <fieldset className="tok-opt-group">
                <legend>Scoring Batch Size</legend>
                <span className="form-hint">
                  Number of message templates sent per LLM API call. Larger batches reduce overhead
                  (the system prompt is repeated with every call) but increase latency per call.
                </span>
                <div className="tok-opt-row">
                  <label>Templates per batch</label>
                  <NumericInput
                    min={1} max={100} step={1}
                    value={tokCfg.scoring_batch_size}
                    onChange={(v) => setTokCfg({ ...tokCfg, scoring_batch_size: v })}
                    style={{ width: 90 }}
                  />
                </div>
              </fieldset>

              {/* ── Low-Score Auto-Skip ── */}
              <fieldset className="tok-opt-group">
                <legend>Low-Score Auto-Skip (Learned Noise Filter)</legend>
                <span className="form-hint">
                  Templates that have been consistently scored near-zero over multiple pipeline runs
                  are automatically scored at 0 without calling the LLM. This is a "learned noise filter" —
                  the LLM teaches the system what is noise, reducing costs over time.
                </span>
                <div className="tok-opt-row">
                  <label className="tok-opt-toggle">
                    <input
                      type="checkbox"
                      checked={tokCfg.low_score_auto_skip_enabled}
                      onChange={(e) => setTokCfg({ ...tokCfg, low_score_auto_skip_enabled: e.target.checked })}
                    />
                    Enable low-score auto-skip
                  </label>
                </div>
                {tokCfg.low_score_auto_skip_enabled && (
                  <>
                    <div className="tok-opt-row">
                      <label>Score threshold</label>
                      <NumericInput
                        min={0} max={1} step={0.01}
                        value={tokCfg.low_score_threshold}
                        onChange={(v) => setTokCfg({ ...tokCfg, low_score_threshold: v })}
                        style={{ width: 90 }}
                      />
                      <span className="form-hint">Templates with avg max score below this are auto-skipped.</span>
                    </div>
                    <div className="tok-opt-row">
                      <label>Min scorings before skip</label>
                      <NumericInput
                        min={1} max={100} step={1}
                        value={tokCfg.low_score_min_scorings}
                        onChange={(v) => setTokCfg({ ...tokCfg, low_score_min_scorings: v })}
                        style={{ width: 90 }}
                      />
                      <span className="form-hint">Template must be scored at least this many times before auto-skip activates.</span>
                    </div>
                  </>
                )}
              </fieldset>

              {/* ── Meta-Analysis ── */}
              <fieldset className="tok-opt-group">
                <legend>Meta-Analysis Optimization</legend>
                <span className="form-hint">
                  Control how many events are sent to the meta-analysis LLM call and whether
                  high-scoring events are prioritised.
                </span>
                <div className="tok-opt-row">
                  <label>Max events per window</label>
                  <NumericInput
                    min={10} max={2000} step={10}
                    value={tokCfg.meta_max_events}
                    onChange={(v) => setTokCfg({ ...tokCfg, meta_max_events: v })}
                    style={{ width: 90 }}
                  />
                </div>
                <div className="tok-opt-row">
                  <label className="tok-opt-toggle">
                    <input
                      type="checkbox"
                      checked={tokCfg.meta_prioritize_high_scores}
                      onChange={(e) => setTokCfg({ ...tokCfg, meta_prioritize_high_scores: e.target.checked })}
                    />
                    Prioritise high-score events (sort by score desc before cap)
                  </label>
                </div>
                <div className="tok-opt-row">
                  <label className="tok-opt-toggle">
                    <input
                      type="checkbox"
                      checked={tokCfg.skip_zero_score_meta ?? true}
                      onChange={(e) => setTokCfg({ ...tokCfg, skip_zero_score_meta: e.target.checked })}
                    />
                    Skip meta-analysis when all events scored 0 (O1)
                  </label>
                  <span className="form-hint">
                    When every event in a window is routine (score 0), skip the LLM call entirely and write synthetic zero scores. Saves the most tokens for quiet systems.
                  </span>
                </div>
                <div className="tok-opt-row">
                  <label className="tok-opt-toggle">
                    <input
                      type="checkbox"
                      checked={tokCfg.filter_zero_score_meta_events ?? true}
                      onChange={(e) => setTokCfg({ ...tokCfg, filter_zero_score_meta_events: e.target.checked })}
                    />
                    Filter zero-score events from meta-analysis prompt (O2)
                  </label>
                  <span className="form-hint">
                    Exclude events that scored 0 from the meta-analysis LLM context, reducing input tokens. Only active events (score &gt; 0) are sent.
                  </span>
                </div>
              </fieldset>

              {/* ── Actions ── */}
              <div className="prompt-editor-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={savingTok}
                  onClick={async () => {
                    setSavingTok(true);
                    setTokError('');
                    setTokSuccess('');
                    try {
                      const updated = await updateTokenOptConfig(tokCfg);
                      setTokenOpt(updated);
                      setTokCfg(updated.config);
                      setTokSuccess('Token optimization settings saved. Takes effect on next pipeline run.');
                    } catch (err: unknown) {
                      const msg = err instanceof Error ? err.message : String(err);
                      if (msg.includes('Authentication')) { onAuthError(); return; }
                      setTokError(msg);
                    } finally {
                      setSavingTok(false);
                    }
                  }}
                >
                  {savingTok ? 'Saving...' : 'Save Settings'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  disabled={savingTok || invalidating}
                  onClick={async () => {
                    if (!window.confirm('Invalidate all cached template scores? Templates will be re-scored by the LLM on the next pipeline run.')) return;
                    setInvalidating(true);
                    setTokError('');
                    setTokSuccess('');
                    try {
                      const res = await invalidateScoreCache();
                      setTokSuccess(`Score cache cleared: ${res.cleared} templates invalidated.`);
                      // Refresh stats
                      const updated = await fetchTokenOptConfig();
                      setTokenOpt(updated);
                    } catch (err: unknown) {
                      const msg = err instanceof Error ? err.message : String(err);
                      if (msg.includes('Authentication')) { onAuthError(); return; }
                      setTokError(msg);
                    } finally {
                      setInvalidating(false);
                    }
                  }}
                >
                  {invalidating ? 'Clearing...' : 'Invalidate Score Cache'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  disabled={savingTok}
                  onClick={async () => {
                    if (!window.confirm('Reset all token optimization settings to defaults?')) return;
                    setSavingTok(true);
                    setTokError('');
                    setTokSuccess('');
                    try {
                      const updated = await updateTokenOptConfig(tokenOpt?.defaults ?? {});
                      setTokenOpt(updated);
                      setTokCfg(updated.config);
                      setTokSuccess('Settings reset to defaults.');
                    } catch (err: unknown) {
                      const msg = err instanceof Error ? err.message : String(err);
                      if (msg.includes('Authentication')) { onAuthError(); return; }
                      setTokError(msg);
                    } finally {
                      setSavingTok(false);
                    }
                  }}
                >
                  Reset to Defaults
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Meta-Analysis Tuning ─────────────────────────── */}
      <div className="ai-prompts-section">
        <h3>Meta-Analysis Tuning</h3>
        <p className="ai-config-desc">
          Control how findings are deduplicated, how stale findings are auto-resolved,
          and how severity decays for persistent non-impactful findings.
          Inspired by Sentry, PagerDuty, and Datadog alert management.
        </p>

        {metaError && (
          <div className="error-msg" role="alert">
            {metaError}
            <button className="error-dismiss" onClick={() => setMetaError('')} aria-label="Dismiss">&times;</button>
          </div>
        )}
        {metaSuccess && (
          <div className="success-msg" role="status">
            {metaSuccess}
            <button className="error-dismiss" onClick={() => setMetaSuccess('')} aria-label="Dismiss">&times;</button>
          </div>
        )}

        <div className="prompt-block">
          <button
            type="button"
            className="prompt-toggle"
            onClick={() => setShowMetaAnalysis((v) => !v)}
          >
            <span className={`prompt-chevron${showMetaAnalysis ? ' open' : ''}`}>&#9654;</span>
            Finding Quality Settings
            {metaAnalysis?.stats && (
              <span className="prompt-custom-badge">
                {metaAnalysis.stats.total_open_findings} open findings
              </span>
            )}
          </button>

          {showMetaAnalysis && metaCfg && (
            <div className="prompt-editor tok-opt-editor">

              {/* Stats banner */}
              {metaAnalysis?.stats && metaAnalysis.stats.total_open_findings > 0 && (
                <div className="meta-stats-banner">
                  <span>Open: <strong>{metaAnalysis.stats.total_open_findings}</strong></span>
                  <span>Avg occurrences: <strong>{metaAnalysis.stats.avg_occurrence_count}</strong></span>
                  <span>Max occurrences: <strong>{metaAnalysis.stats.max_occurrence_count}</strong></span>
                  <span>Avg misses: <strong>{metaAnalysis.stats.avg_consecutive_misses}</strong></span>
                </div>
              )}

              {/* ── Finding Deduplication ── */}
              <fieldset className="tok-opt-group">
                <legend>Finding Deduplication</legend>
                <span className="form-hint">
                  Uses TF-IDF cosine similarity and Jaccard similarity to detect duplicate findings
                  after the LLM returns them. Duplicates update existing findings instead of creating new ones.
                </span>
                <div className="tok-opt-row">
                  <label className="tok-opt-toggle">
                    <input
                      type="checkbox"
                      checked={metaCfg.finding_dedup_enabled}
                      onChange={(e) => setMetaCfg({ ...metaCfg, finding_dedup_enabled: e.target.checked })}
                    />
                    Enable finding deduplication
                  </label>
                </div>
                {metaCfg.finding_dedup_enabled && (
                  <div className="tok-opt-row">
                    <label>Similarity threshold</label>
                    <NumericInput
                      min={0.1} max={1.0} step={0.05}
                      value={metaCfg.finding_dedup_threshold}
                      onChange={(v) => setMetaCfg({ ...metaCfg, finding_dedup_threshold: v })}
                      style={{ width: 90 }}
                    />
                    <span className="form-hint">
                      Findings with similarity above this threshold are considered duplicates (0.5 = relaxed, 0.8 = strict).
                    </span>
                  </div>
                )}
                <div className="tok-opt-row">
                  <label>Max new findings per window</label>
                  <NumericInput
                    min={1} max={50} step={1}
                    value={metaCfg.max_new_findings_per_window}
                    onChange={(v) => setMetaCfg({ ...metaCfg, max_new_findings_per_window: v })}
                    style={{ width: 90 }}
                  />
                  <span className="form-hint">
                    Hard cap on new findings created per analysis window (safety net).
                  </span>
                </div>
              </fieldset>

              {/* ── Auto-Resolution ── */}
              <fieldset className="tok-opt-group">
                <legend>Auto-Resolution of Stale Findings</legend>
                <span className="form-hint">
                  Findings not observed for N consecutive analysis windows are automatically resolved.
                  This models PagerDuty's auto-pause behaviour — if an issue fixes itself, the finding closes.
                </span>
                <div className="tok-opt-row">
                  <label>Auto-resolve after (windows)</label>
                  <NumericInput
                    min={0} max={100} step={1}
                    value={metaCfg.auto_resolve_after_misses}
                    onChange={(v) => setMetaCfg({ ...metaCfg, auto_resolve_after_misses: v })}
                    style={{ width: 90 }}
                  />
                  <span className="form-hint">
                    Set to 0 to disable auto-resolution. Recommended: 3-10 depending on window interval.
                  </span>
                </div>
              </fieldset>

              {/* ── Severity Decay ── */}
              <fieldset className="tok-opt-group">
                <legend>Severity Decay</legend>
                <span className="form-hint">
                  Findings that keep recurring without causing actual outages have their severity
                  gradually reduced (critical → high → medium). This models how a human analyst
                  adjusts urgency over time for persistent benign patterns.
                </span>
                <div className="tok-opt-row">
                  <label className="tok-opt-toggle">
                    <input
                      type="checkbox"
                      checked={metaCfg.severity_decay_enabled}
                      onChange={(e) => setMetaCfg({ ...metaCfg, severity_decay_enabled: e.target.checked })}
                    />
                    Enable severity decay
                  </label>
                </div>
                {metaCfg.severity_decay_enabled && (
                  <div className="tok-opt-row">
                    <label>Decay after (occurrences)</label>
                    <NumericInput
                      min={1} max={100} step={1}
                      value={metaCfg.severity_decay_after_occurrences}
                      onChange={(v) => setMetaCfg({ ...metaCfg, severity_decay_after_occurrences: v })}
                      style={{ width: 90 }}
                    />
                    <span className="form-hint">
                      After this many occurrences, critical → high, high → medium. Severity never decays below medium.
                    </span>
                  </div>
                )}
              </fieldset>

              {/* ── Max Open Findings Cap ── */}
              <fieldset className="tok-opt-group">
                <legend>Max Open Findings Cap</legend>
                <span className="form-hint">
                  Hard limit on open findings per system. If exceeded, the lowest-priority
                  findings (info, then low, oldest first) are auto-resolved to make room.
                </span>
                <div className="tok-opt-row">
                  <label>Max open findings per system</label>
                  <NumericInput
                    min={5} max={200} step={1}
                    value={metaCfg.max_open_findings_per_system}
                    onChange={(v) => setMetaCfg({ ...metaCfg, max_open_findings_per_system: v })}
                    style={{ width: 90 }}
                  />
                </div>
              </fieldset>

              {/* ── LLM Context Size ── */}
              <fieldset className="tok-opt-group">
                <legend>LLM Context Tuning</legend>
                <span className="form-hint">
                  Control how much historical context is included in the LLM meta-analysis prompt.
                  More context provides better analysis but uses more tokens.
                </span>
                <div className="tok-opt-row">
                  <label>Previous window summaries (context size)</label>
                  <NumericInput
                    min={1} max={20} step={1}
                    value={metaCfg.context_window_size ?? 5}
                    onChange={(v) => setMetaCfg({ ...metaCfg, context_window_size: v })}
                    style={{ width: 90 }}
                  />
                  <span className="form-hint">
                    Number of previous analysis window summaries included as LLM context. Default: 5.
                  </span>
                </div>
                <div className="tok-opt-row">
                  <label>Recurring lookback (days)</label>
                  <NumericInput
                    min={1} max={90} step={1}
                    value={metaCfg.recurring_lookback_days ?? 14}
                    onChange={(v) => setMetaCfg({ ...metaCfg, recurring_lookback_days: v })}
                    style={{ width: 90 }}
                  />
                  <span className="form-hint">
                    How far back (days) to check for recently resolved findings when detecting recurring issues. Default: 14.
                  </span>
                </div>
              </fieldset>

              {/* ── Actions ── */}
              <div className="prompt-editor-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={savingMeta}
                  onClick={async () => {
                    setSavingMeta(true);
                    setMetaError('');
                    setMetaSuccess('');
                    try {
                      const updated = await updateMetaAnalysisConfig(metaCfg);
                      setMetaCfg(updated.config);
                      setMetaSuccess('Meta-analysis settings saved. Takes effect on next pipeline run.');
                      // Refresh stats
                      const full = await fetchMetaAnalysisConfig();
                      setMetaAnalysis(full);
                    } catch (err: unknown) {
                      const msg = err instanceof Error ? err.message : String(err);
                      if (msg.includes('Authentication')) { onAuthError(); return; }
                      setMetaError(msg);
                    } finally {
                      setSavingMeta(false);
                    }
                  }}
                >
                  {savingMeta ? 'Saving...' : 'Save Settings'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  disabled={savingMeta}
                  onClick={async () => {
                    if (!window.confirm('Reset all meta-analysis settings to defaults?')) return;
                    setSavingMeta(true);
                    setMetaError('');
                    setMetaSuccess('');
                    try {
                      const updated = await updateMetaAnalysisConfig(metaAnalysis?.defaults ?? {});
                      setMetaCfg(updated.config);
                      setMetaSuccess('Settings reset to defaults.');
                      const full = await fetchMetaAnalysisConfig();
                      setMetaAnalysis(full);
                    } catch (err: unknown) {
                      const msg = err instanceof Error ? err.message : String(err);
                      if (msg.includes('Authentication')) { onAuthError(); return; }
                      setMetaError(msg);
                    } finally {
                      setSavingMeta(false);
                    }
                  }}
                >
                  Reset to Defaults
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Pipeline Settings ───────────────────────────── */}
      <div className="ai-prompts-section">
        <h3>Pipeline Settings</h3>
        <p className="ai-config-desc">
          Control the AI analysis pipeline scheduling, window size, and scoring parameters.
          Changes take effect on the next pipeline cycle.
        </p>

        {pipeError && (
          <div className="error-msg" role="alert">
            {pipeError}
            <button className="error-dismiss" onClick={() => setPipeError('')} aria-label="Dismiss">&times;</button>
          </div>
        )}
        {pipeSuccess && (
          <div className="success-msg" role="status">
            {pipeSuccess}
            <button className="error-dismiss" onClick={() => setPipeSuccess('')} aria-label="Dismiss">&times;</button>
          </div>
        )}

        <div className="prompt-block">
          <button
            type="button"
            className="prompt-toggle"
            onClick={() => setShowPipeline((v) => !v)}
          >
            <span className={`prompt-chevron${showPipeline ? ' open' : ''}`}>&#9654;</span>
            Pipeline Configuration
          </button>

          {showPipeline && pipeCfg && (
            <div className="prompt-editor tok-opt-editor">
              <fieldset className="tok-opt-group">
                <legend>Scheduling</legend>
                <span className="form-hint">
                  How often the AI analysis pipeline runs and how large each analysis window is.
                </span>
                <div className="tok-opt-row">
                  <label>Min interval (active)</label>
                  <NumericInput
                    min={1} max={60} step={1}
                    value={pipeCfg.pipeline_min_interval_minutes}
                    onChange={(v) => setPipeCfg({ ...pipeCfg, pipeline_min_interval_minutes: v })}
                    style={{ width: 90 }}
                  />
                  <span className="form-hint">
                    Minimum pipeline interval when events are actively arriving (minutes). Default: 5 min.
                  </span>
                </div>
                <div className="tok-opt-row">
                  <label>Max interval (idle)</label>
                  <NumericInput
                    min={5} max={1440} step={1}
                    value={pipeCfg.pipeline_max_interval_minutes}
                    onChange={(v) => setPipeCfg({ ...pipeCfg, pipeline_max_interval_minutes: v })}
                    style={{ width: 90 }}
                  />
                  <span className="form-hint">
                    Maximum pipeline interval when idle / no new events (minutes). Default: 60 min.
                  </span>
                </div>
                <div className="tok-opt-row">
                  <label>Analysis window (minutes)</label>
                  <NumericInput
                    min={1} max={60} step={1}
                    value={pipeCfg.window_minutes}
                    onChange={(v) => setPipeCfg({ ...pipeCfg, window_minutes: v })}
                    style={{ width: 90 }}
                  />
                  <span className="form-hint">
                    Size of each analysis window. Should match the pipeline interval. Default: 5 min.
                  </span>
                </div>
              </fieldset>

              <fieldset className="tok-opt-group">
                <legend>Scoring &amp; Weights</legend>
                <div className="tok-opt-row">
                  <label>Scoring limit per run</label>
                  <NumericInput
                    min={10} max={5000} step={10}
                    value={pipeCfg.scoring_limit_per_run}
                    onChange={(v) => setPipeCfg({ ...pipeCfg, scoring_limit_per_run: v })}
                    style={{ width: 90 }}
                  />
                  <span className="form-hint">
                    Maximum number of events scored per pipeline run. Default: 500.
                  </span>
                </div>
                <div className="tok-opt-row">
                  <label>Meta-analysis weight (effective score)</label>
                  <NumericInput
                    min={0} max={1} step={0.05}
                    value={pipeCfg.effective_score_meta_weight}
                    onChange={(v) => setPipeCfg({ ...pipeCfg, effective_score_meta_weight: v })}
                    style={{ width: 90 }}
                  />
                  <span className="form-hint">
                    Weight of meta-analysis score in the blended effective score (0.0 = per-event only, 1.0 = meta only). Default: 0.7.
                  </span>
                </div>
                <div className="tok-opt-row">
                  <label className="tok-opt-toggle">
                    <input
                      type="checkbox"
                      checked={pipeCfg.normalize_sql_statements === true}
                      onChange={(e) => setPipeCfg({ ...pipeCfg, normalize_sql_statements: e.target.checked })}
                    />
                    Normalize SQL statements
                  </label>
                  <span className="form-hint">
                    Collapse SQL clauses (WHERE, ORDER BY, LIMIT, etc.) in PostgreSQL STATEMENT lines so that the same query against the same table groups regardless of clause variations. Default: disabled.
                  </span>
                </div>
              </fieldset>

              <fieldset className="tok-opt-group">
                <legend>Ingestion</legend>
                <div className="tok-opt-row">
                  <label className="tok-opt-toggle">
                    <input
                      type="checkbox"
                      checked={pipeCfg.multiline_reassembly !== false}
                      onChange={(e) => setPipeCfg({ ...pipeCfg, multiline_reassembly: e.target.checked })}
                    />
                    Multiline syslog reassembly
                  </label>
                  <span className="form-hint">
                    Automatically merge multiline syslog messages (e.g. PostgreSQL continuation lines) into a single event during ingestion. Default: enabled.
                  </span>
                </div>
                <div className="tok-opt-row">
                  <label>Max future drift (seconds)</label>
                  <NumericInput
                    min={0} max={86400} step={60}
                    value={pipeCfg.max_future_drift_seconds ?? 300}
                    onChange={(v) => setPipeCfg({ ...pipeCfg, max_future_drift_seconds: v })}
                    style={{ width: 110 }}
                  />
                  <span className="form-hint">
                    Events with timestamps further into the future than this are clamped to the current time. Prevents clock-skew and timezone errors from polluting data. Set to 0 to disable. Default: 300 (5 min).
                  </span>
                </div>
                <div className="tok-opt-row">
                  <label>Max event message length</label>
                  <NumericInput
                    min={256} max={65536} step={256}
                    value={pipeCfg.max_event_message_length ?? 8192}
                    onChange={(v) => setPipeCfg({ ...pipeCfg, max_event_message_length: v })}
                    style={{ width: 110 }}
                  />
                  <span className="form-hint">
                    Characters (256–65536). Messages longer than this are truncated during ingestion. Default: 8192.
                  </span>
                </div>
              </fieldset>

              <div className="prompt-editor-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={savingPipe}
                  onClick={async () => {
                    setSavingPipe(true);
                    setPipeError('');
                    setPipeSuccess('');
                    try {
                      const updated = await updatePipelineConfig(pipeCfg);
                      setPipelineCfgResp(updated);
                      setPipeCfg(updated.config);
                      setPipeSuccess('Pipeline settings saved. Takes effect on the next cycle.');
                    } catch (err: unknown) {
                      const msg = err instanceof Error ? err.message : String(err);
                      if (msg.includes('Authentication')) { onAuthError(); return; }
                      setPipeError(msg);
                    } finally {
                      setSavingPipe(false);
                    }
                  }}
                >
                  {savingPipe ? 'Saving...' : 'Save Settings'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  disabled={savingPipe}
                  onClick={async () => {
                    if (!window.confirm('Reset pipeline settings to defaults?')) return;
                    setSavingPipe(true);
                    setPipeError('');
                    setPipeSuccess('');
                    try {
                      const updated = await updatePipelineConfig(pipelineCfgResp?.defaults ?? {});
                      setPipelineCfgResp(updated);
                      setPipeCfg(updated.config);
                      setPipeSuccess('Settings reset to defaults.');
                    } catch (err: unknown) {
                      const msg = err instanceof Error ? err.message : String(err);
                      if (msg.includes('Authentication')) { onAuthError(); return; }
                      setPipeError(msg);
                    } finally {
                      setSavingPipe(false);
                    }
                  }}
                >
                  Reset to Defaults
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Per-Task Model Configuration (O3) ────────────── */}
      <div className="ai-prompts-section">
        <h3>Per-Task Model Overrides</h3>
        <p className="ai-config-desc">
          Optionally use different LLM models for different tasks. Leave empty to use the global model configured above.
          Useful for cost optimization (e.g., cheaper model for scoring, better model for meta-analysis).
        </p>

        {taskModelError && (
          <div className="error-msg" role="alert">
            {taskModelError}
            <button className="error-dismiss" onClick={() => setTaskModelError('')} aria-label="Dismiss">&times;</button>
          </div>
        )}
        {taskModelSuccess && (
          <div className="success-msg" role="status">
            {taskModelSuccess}
            <button className="error-dismiss" onClick={() => setTaskModelSuccess('')} aria-label="Dismiss">&times;</button>
          </div>
        )}

        <div className="prompt-block">
          <button
            type="button"
            className="prompt-toggle"
            onClick={() => setShowTaskModel((v) => !v)}
          >
            <span className={`prompt-chevron${showTaskModel ? ' open' : ''}`}>&#9654;</span>
            Task Model Settings
          </button>

          {showTaskModel && taskModelCfg && (
            <div className="prompt-editor tok-opt-editor">
              <fieldset className="tok-opt-group">
                <legend>Model per Task</legend>
                <span className="form-hint">
                  Specify model names (e.g., <code>gpt-4o-mini</code>, <code>gpt-4o</code>).
                  Leave empty to use the global model.
                </span>
                <div className="tok-opt-row">
                  <label>Scoring model</label>
                  <input
                    type="text"
                    className="form-input"
                    value={taskModelCfg.scoring_model}
                    onChange={(e) => setTaskModelCfg({ ...taskModelCfg, scoring_model: e.target.value })}
                    placeholder="(use global model)"
                    style={{ width: 220 }}
                  />
                  <span className="form-hint">Model for per-event scoring LLM calls.</span>
                </div>
                <div className="tok-opt-row">
                  <label>Meta-analysis model</label>
                  <input
                    type="text"
                    className="form-input"
                    value={taskModelCfg.meta_model}
                    onChange={(e) => setTaskModelCfg({ ...taskModelCfg, meta_model: e.target.value })}
                    placeholder="(use global model)"
                    style={{ width: 220 }}
                  />
                  <span className="form-hint">Model for meta-analysis / summary LLM calls.</span>
                </div>
                <div className="tok-opt-row">
                  <label>Ask AI (RAG) model</label>
                  <input
                    type="text"
                    className="form-input"
                    value={taskModelCfg.rag_model}
                    onChange={(e) => setTaskModelCfg({ ...taskModelCfg, rag_model: e.target.value })}
                    placeholder="(use global model)"
                    style={{ width: 220 }}
                  />
                  <span className="form-hint">Model for the "Ask AI" natural language query feature.</span>
                </div>
              </fieldset>

              <div className="prompt-editor-actions">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={savingTaskModel}
                  onClick={async () => {
                    setSavingTaskModel(true);
                    setTaskModelError('');
                    setTaskModelSuccess('');
                    try {
                      const updated = await updateTaskModelConfig(taskModelCfg);
                      setTaskModelResp(updated);
                      setTaskModelCfg(updated.config);
                      setTaskModelSuccess('Per-task model settings saved. Takes effect on next pipeline run.');
                    } catch (err: unknown) {
                      const msg = err instanceof Error ? err.message : String(err);
                      if (msg.includes('Authentication')) { onAuthError(); return; }
                      setTaskModelError(msg);
                    } finally {
                      setSavingTaskModel(false);
                    }
                  }}
                >
                  {savingTaskModel ? 'Saving...' : 'Save Settings'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline"
                  disabled={savingTaskModel}
                  onClick={async () => {
                    if (!window.confirm('Clear all per-task model overrides? All tasks will use the global model.')) return;
                    setSavingTaskModel(true);
                    setTaskModelError('');
                    setTaskModelSuccess('');
                    try {
                      const updated = await updateTaskModelConfig({ scoring_model: '', meta_model: '', rag_model: '' });
                      setTaskModelResp(updated);
                      setTaskModelCfg(updated.config);
                      setTaskModelSuccess('Per-task models cleared. Using global model for all tasks.');
                    } catch (err: unknown) {
                      const msg = err instanceof Error ? err.message : String(err);
                      if (msg.includes('Authentication')) { onAuthError(); return; }
                      setTaskModelError(msg);
                    } finally {
                      setSavingTaskModel(false);
                    }
                  }}
                >
                  Clear All Overrides
                </button>
              </div>
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
