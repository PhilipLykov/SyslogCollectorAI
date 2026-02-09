import { useState } from 'react';
import { type DashboardSystem, acknowledgeEvents, fetchFindings, acknowledgeFinding } from '../api';
import { ScoreBars } from './ScoreBar';

interface SystemCardProps {
  system: DashboardSystem;
  onClick: () => void;
  onAuthError: () => void;
}

export function SystemCard({ system, onClick, onAuthError }: SystemCardProps) {
  const [acking, setAcking] = useState(false);
  const [ackMsg, setAckMsg] = useState('');

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };

  const handleAckEvents = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(
      `Acknowledge ALL events for "${system.name}" up to now?\n\nAcknowledged events will be excluded from future LLM scoring.`,
    )) return;
    setAcking(true);
    setAckMsg('');
    try {
      const res = await acknowledgeEvents({ system_id: system.id });
      setAckMsg(res.message);
      setTimeout(() => setAckMsg(''), 4000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setAckMsg(`Error: ${msg}`);
      setTimeout(() => setAckMsg(''), 5000);
    } finally {
      setAcking(false);
    }
  };

  const handleAckFindings = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(
      `Acknowledge ALL open findings for "${system.name}"?`,
    )) return;
    setAcking(true);
    setAckMsg('');
    try {
      const openFindings = await fetchFindings(system.id, { status: 'open', limit: 500 });
      if (openFindings.length === 0) {
        setAckMsg('No open findings to acknowledge.');
        setTimeout(() => setAckMsg(''), 3000);
        setAcking(false);
        return;
      }
      let acked = 0;
      for (const f of openFindings) {
        await acknowledgeFinding(f.id);
        acked++;
      }
      setAckMsg(`${acked} finding${acked !== 1 ? 's' : ''} acknowledged.`);
      setTimeout(() => setAckMsg(''), 4000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Authentication')) { onAuthError(); return; }
      setAckMsg(`Error: ${msg}`);
      setTimeout(() => setAckMsg(''), 5000);
    } finally {
      setAcking(false);
    }
  };

  const eventCount = Number.isFinite(system.event_count_24h) ? system.event_count_24h : 0;
  const lastWindowTime = system.latest_window
    ? formatEuTime(system.latest_window.to)
    : null;

  return (
    <div
      className="system-card"
      onClick={onClick}
      onKeyDown={handleKeyDown}
      role="listitem"
      tabIndex={0}
      aria-label={`View details for ${system.name}`}
    >
      <h3>{system.name}</h3>
      <div className="meta">
        {system.source_count} source{system.source_count !== 1 ? 's' : ''}
        {' · '}
        {eventCount.toLocaleString()} events (24h)
        {lastWindowTime && (
          <>
            {' · '}
            Last window: {lastWindowTime}
          </>
        )}
      </div>
      {Object.keys(system.scores).length > 0 ? (
        <ScoreBars scores={system.scores} />
      ) : (
        <div className="no-scores-msg">
          No scores yet — awaiting pipeline run
        </div>
      )}
      <div className="sc-actions" onClick={(ev) => ev.stopPropagation()}>
        <button
          className="btn btn-xs btn-outline"
          onClick={handleAckEvents}
          disabled={acking}
          title="Acknowledge all events up to now"
        >
          {acking ? '...' : 'Ack events'}
        </button>
        <button
          className="btn btn-xs btn-outline"
          onClick={handleAckFindings}
          disabled={acking}
          title="Acknowledge all open findings"
        >
          {acking ? '...' : 'Ack findings'}
        </button>
      </div>
      {ackMsg && (
        <div className={`sc-ack-msg${ackMsg.startsWith('Error') ? ' sc-ack-error' : ''}`}>
          {ackMsg}
        </div>
      )}
    </div>
  );
}

/** Format a timestamp as DD.MM.YYYY HH:MM:SS (EU format). */
function formatEuTime(ts: string): string {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}`;
  } catch {
    return ts;
  }
}
