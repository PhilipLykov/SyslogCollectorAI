import { type SystemScoreInfo } from '../api';

const CRITERIA_LABELS: Record<string, string> = {
  it_security: 'IT Security',
  performance_degradation: 'Performance',
  failure_prediction: 'Failure Prediction',
  anomaly: 'Anomaly',
  compliance_audit: 'Compliance / Audit',
  operational_risk: 'Operational Risk',
};

const CRITERIA_ORDER = [
  'it_security',
  'performance_degradation',
  'failure_prediction',
  'anomaly',
  'compliance_audit',
  'operational_risk',
];

function scoreColor(value: number): string {
  if (value >= 0.75) return 'var(--red)';
  if (value >= 0.5) return 'var(--orange)';
  if (value >= 0.25) return 'var(--yellow)';
  return 'var(--green)';
}

function scoreLevel(value: number): string {
  if (value >= 0.75) return 'Critical';
  if (value >= 0.5) return 'Warning';
  if (value >= 0.25) return 'Moderate';
  return 'Normal';
}

interface ScoreBarsProps {
  scores: Record<string, SystemScoreInfo>;
  /** If provided, bars become clickable. Called with criterion slug. */
  onCriterionClick?: (slug: string) => void;
  /** Currently selected criterion slug (for highlighting). */
  selectedCriterion?: string | null;
}

export function ScoreBars({ scores, onCriterionClick, selectedCriterion }: ScoreBarsProps) {
  return (
    <div className="score-bars" role="list" aria-label="Security scores">
      {CRITERIA_ORDER.map((slug) => {
        const info = scores[slug];
        const raw = info?.effective;
        const value = Number.isFinite(raw) ? raw : 0;
        const pct = Math.round(value * 100);
        const label = CRITERIA_LABELS[slug] ?? slug;
        const isClickable = !!onCriterionClick;
        const isSelected = selectedCriterion === slug;

        return (
          <div
            className={`score-row${isClickable ? ' clickable' : ''}${isSelected ? ' selected' : ''}`}
            key={slug}
            role="listitem"
            onClick={isClickable ? () => onCriterionClick!(slug) : undefined}
            onKeyDown={isClickable ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onCriterionClick!(slug);
              }
            } : undefined}
            tabIndex={isClickable ? 0 : undefined}
            style={{ cursor: isClickable ? 'pointer' : undefined }}
          >
            <span className="score-label" id={`score-label-${slug}`}>{label}</span>
            <div
              className="score-bar-bg"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-labelledby={`score-label-${slug}`}
              aria-valuetext={`${label}: ${pct}% — ${scoreLevel(value)}`}
              title={isClickable ? `Click to see events scored for ${label}` : `${label}: ${pct}% — ${scoreLevel(value)}`}
            >
              <div
                className="score-bar-fill"
                style={{
                  width: `${pct}%`,
                  backgroundColor: scoreColor(value),
                }}
              />
            </div>
            <span className="score-value" style={{ color: scoreColor(value) }} aria-hidden="true">
              {pct}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Exported for use by other components */
export { CRITERIA_LABELS, CRITERIA_ORDER };
