import type { Company } from "../src/company.js";

/** The answer every scoring test scores against. Mirrors v1's fixture so the ported tests read the same. */
export const ANSWER: Company = {
  id: "answer.com",
  date: "2026-01-01",
  domain: "answer.com",
  name: "Answer Co",
  logoUrl: "https://example.com/a.png",
  sectors: ["Fintech", "Payments"],
  businessModel: ["B2B"],
  hqCountry: "ES",
  region: "Europe",
  foundedYear: 2015,
  fundingStage: "Series B",
  totalFundingUsd: 30_000_000,
  headcount: 150,
};

/** A guess that differs from the answer only where the test says so — and always in `id`. */
export function guess(overrides: Partial<Company> = {}): Company {
  return {
    ...ANSWER,
    ...overrides,
    id: "guess.com",
    domain: "guess.com",
    name: "Guess Co",
  };
}
