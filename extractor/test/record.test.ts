import { describe, expect, it } from "vitest";
import { CompanySchema } from "@venturedle/shared/server";
import type { HarmonicFacts } from "../src/evidence.js";
import type { Extraction } from "../src/llm.js";
import { buildRecord } from "../src/record.js";

const facts: HarmonicFacts = {
  harmonicId: 481523,
  name: "Klarna",
  logoUrl: "https://assets.harmonic.ai/klarna.png",
  headcount: 4585,
  totalFundingUsd: 9460186174,
  foundedYear: 2005,
};

const extraction: Extraction = {
  sectors: ["Fintech", "Payments"],
  businessModel: ["B2C"],
  hqCountry: "SE",
  foundedYear: 2005,
  fundingStage: "Public",
  confidence: "high",
  notes: "IPO in the round types.",
};

function build(
  factsOverride: Partial<HarmonicFacts> = {},
  extractionOverride: Partial<Extraction> = {},
) {
  return buildRecord({
    domain: "klarna.com",
    facts: { ...facts, ...factsOverride },
    extraction: { ...extraction, ...extractionOverride },
    harmonicFetchedAt: "2026-09-18T10:00:00.000Z",
    llmLabel: "anthropic/claude-opus-5",
  });
}

describe("buildRecord", () => {
  it("merges Harmonic's numbers with the LLM's categories", () => {
    const result = build();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record).toEqual({
      id: "klarna.com",
      domain: "klarna.com",
      name: "Klarna",
      logoUrl: "https://assets.harmonic.ai/klarna.png",
      sectors: ["Fintech", "Payments"],
      businessModel: ["B2C"],
      hqCountry: "SE",
      region: "Europe",
      foundedYear: 2005,
      fundingStage: "Public",
      totalFundingUsd: 9460186174,
      headcount: 4585,
      source: {
        harmonicId: 481523,
        harmonicFetchedAt: "2026-09-18T10:00:00.000Z",
        llm: "anthropic/claude-opus-5",
        notes: "IPO in the round types.",
      },
    });
    expect("date" in result.record).toBe(false); // assigned later, once we know who survived
  });

  it("derives region from hqCountry", () => {
    const result = build({}, { hqCountry: "SG" });
    expect(result.ok && result.record.region).toBe("Asia");
  });

  it.each([
    [{ headcount: null }, "missing_headcount"],
    [{ totalFundingUsd: null }, "missing_funding_total"],
  ] as const)("rejects when Harmonic has no %o", (override, reason) => {
    expect(build(override)).toEqual({ ok: false, reason });
  });

  it("lets the LLM fill foundedYear only when Harmonic has none", () => {
    const result = build({ foundedYear: null }, { foundedYear: 2004 });
    expect(result.ok && result.record.foundedYear).toBe(2004);
  });

  it("prefers Harmonic's founding year over the LLM's", () => {
    const result = build({ foundedYear: 2005 }, { foundedYear: 1999 });
    expect(result.ok && result.record.foundedYear).toBe(2005);
  });

  it("rejects when neither has a founding year", () => {
    expect(build({ foundedYear: null }, { foundedYear: null })).toEqual({
      ok: false,
      reason: "missing_founded_year",
    });
  });

  it("keeps a low-confidence extraction but flags it in the notes", () => {
    const result = build(
      {},
      { confidence: "low", notes: "guessed the stage from the description" },
    );
    expect(result.ok && result.record.source?.notes).toBe(
      "low confidence — guessed the stage from the description",
    );
  });

  it("rejects with zod_<path> when the merged record fails the schema", () => {
    expect(build({}, { hqCountry: "se" })).toEqual({
      ok: false,
      reason: "zod_hqCountry",
    });
    expect(build({ logoUrl: "http://insecure.example/logo.png" })).toEqual({
      ok: false,
      reason: "zod_logoUrl",
    });
  });

  it("produces something CompanySchema accepts once a date is added", () => {
    const result = build();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() =>
      CompanySchema.parse({ ...result.record, date: "2026-10-01" }),
    ).not.toThrow();
  });
});
