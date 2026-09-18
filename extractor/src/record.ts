/**
 * Merge: Harmonic's numbers + the LLM's categories → one `Company`, or a rejection. This is where
 * invariant 2 is enforced — a missing number is never guessed.
 */
import {
  CompanySchema,
  regionOf,
  type Company,
} from "@venturedle/shared/server";
import type { HarmonicFacts } from "./evidence.js";
import type { Extraction } from "./llm.js";
import type { RejectionReason } from "./types.js";

/** `date` is assigned later, once we know which domains survived. */
export type UndatedCompany = Omit<Company, "date">;

export type BuildResult =
  { ok: true; record: UndatedCompany } | { ok: false; reason: RejectionReason };

/** Only ever seen by `CompanySchema` inside this file; `assignDates` overwrites it. */
const PLACEHOLDER_DATE = "1970-01-01";

export interface BuildArgs {
  domain: string;
  facts: HarmonicFacts;
  extraction: Extraction;
  harmonicFetchedAt: string;
  llmLabel: string;
}

export function buildRecord({
  domain,
  facts,
  extraction,
  harmonicFetchedAt,
  llmLabel,
}: BuildArgs): BuildResult {
  if (facts.headcount === null)
    return { ok: false, reason: "missing_headcount" };
  if (facts.totalFundingUsd === null)
    return { ok: false, reason: "missing_funding_total" };

  const foundedYear = facts.foundedYear ?? extraction.foundedYear;
  if (foundedYear === null)
    return { ok: false, reason: "missing_founded_year" };

  const notes =
    extraction.confidence === "low"
      ? `low confidence — ${extraction.notes}`
      : extraction.notes;

  const candidate: Company = {
    id: domain,
    date: PLACEHOLDER_DATE,
    domain,
    name: facts.name,
    logoUrl: facts.logoUrl,
    sectors: extraction.sectors,
    businessModel: extraction.businessModel,
    hqCountry: extraction.hqCountry,
    region: regionOf(extraction.hqCountry),
    foundedYear,
    fundingStage: extraction.fundingStage,
    totalFundingUsd: Math.round(facts.totalFundingUsd),
    headcount: Math.round(facts.headcount),
    source: {
      ...(facts.harmonicId !== undefined
        ? { harmonicId: facts.harmonicId }
        : {}),
      harmonicFetchedAt,
      llm: llmLabel,
      notes,
    },
  };

  const parsed = CompanySchema.safeParse(candidate);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join(".") || "record";
    return { ok: false, reason: `zod_${path}` };
  }

  const { date: _date, ...record } = candidate;
  return { ok: true, record };
}
