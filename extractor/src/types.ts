/**
 * The vocabulary the pipeline speaks: why a domain was dropped, and the one error that stops the
 * whole run instead of dropping a single domain.
 */

/**
 * Every way a single domain can fail. A rejection costs the domain its slot in the schedule but
 * never stops the run — unlike `AbortRunError`. `zod_<path>` is generated at merge time.
 */
export const REJECTION_REASONS = [
  "harmonic_not_found",
  "harmonic_rate_limited",
  "harmonic_error",
  "missing_headcount",
  "missing_funding_total",
  "missing_founded_year",
  "llm_invalid_output",
] as const;
export type RejectionReason =
  (typeof REJECTION_REASONS)[number] | `zod_${string}`;

export interface Rejection {
  domain: string;
  reason: RejectionReason;
  harmonicId?: number;
}

/**
 * Thrown on 401/403 from Harmonic or from the LLM provider. A bad key must never turn into a file
 * full of rejections, so this unwinds the whole run and exits 2.
 */
export class AbortRunError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "AbortRunError";
  }
}
