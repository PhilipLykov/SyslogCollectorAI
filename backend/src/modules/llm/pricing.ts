/**
 * Static pricing table for common OpenAI-compatible models.
 * Values: USD per 1 million tokens.
 *
 * NOTE: These are hardcoded estimates based on published pricing.
 * OpenAI does NOT provide a public pricing API, so these cannot be
 * updated dynamically. If pricing changes, update this file and
 * redeploy. Historical records are unaffected — their cost_estimate
 * was locked in at insert time.
 *
 * Last verified: 2026-02-09
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4o-mini':   { input: 0.15,  output: 0.60  },
  'gpt-4o':        { input: 2.50,  output: 10.00 },
  'gpt-4-turbo':   { input: 10.00, output: 30.00 },
  'gpt-4':         { input: 30.00, output: 60.00 },
  'gpt-3.5-turbo': { input: 0.50,  output: 1.50  },
  'o1':            { input: 15.00, output: 60.00 },
  'o1-mini':       { input: 3.00,  output: 12.00 },
  'o3-mini':       { input: 1.10,  output: 4.40  },
};

/**
 * Estimate cost in USD for a given token usage and model.
 * Returns null if the model is unknown (not in the pricing table).
 */
export function estimateCost(
  tokenInput: number | string,
  tokenOutput: number | string,
  model: string,
): number | null {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return null;
  // Defensive: PG driver may return numeric columns as strings
  const input = Number(tokenInput) || 0;
  const output = Number(tokenOutput) || 0;
  return (input * pricing.input + output * pricing.output) / 1_000_000;
}
