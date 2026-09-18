/**
 * The closed vocabularies the whole game is built on. Editing anything here changes the meaning of
 * every stored grid, so `docs/01-game-rules.md` and `docs/02-data-contract.md` are the spec and the
 * tests in `test/scoring.test.ts` are the guard.
 */

export const FUNDING_STAGES = [
  "Pre-seed",
  "Seed",
  "Series A",
  "Series B",
  "Series C",
  "Series D+",
  "Public",
  "Acquired",
] as const;
export type FundingStage = (typeof FUNDING_STAGES)[number];

export const BUSINESS_MODELS = ["B2B", "B2C", "B2B2C", "Marketplace"] as const;
export type BusinessModel = (typeof BUSINESS_MODELS)[number];

/**
 * Deliberately coarse (~30 values) so that "yellow on at least one shared sector" carries
 * information and so different LLM vendors converge on the same answer. See D4.
 */
export const SECTORS = [
  "AI / ML",
  "Adtech",
  "Aerospace & Defense",
  "Agtech",
  "Biotech",
  "Climate & Energy",
  "Consumer",
  "Crypto / Web3",
  "Cybersecurity",
  "Data & Analytics",
  "Developer Tools",
  "E-commerce",
  "Edtech",
  "Enterprise Software",
  "Fintech",
  "Food & Beverage",
  "Gaming",
  "Hardware & Robotics",
  "Healthtech",
  "HR & Future of Work",
  "Insurtech",
  "Legal & Govtech",
  "Logistics & Supply Chain",
  "Marketplace",
  "Media & Entertainment",
  "Mobility & Automotive",
  "Payments",
  "Proptech & Construction",
  "SaaS Infrastructure",
  "Social",
  "Travel & Hospitality",
] as const;
export type Sector = (typeof SECTORS)[number];

export interface Bucket {
  index: number;
  label: string;
  /** inclusive */
  min: number;
  /** inclusive */
  max: number;
}

/**
 * Edges are disjoint (each `max` is the next `min` minus one), unlike v1 where they overlapped and
 * `bucketOf` resolved the ambiguity by first match. Behaviour at exactly 1,000,000 is unchanged.
 */
export const FUNDING_BUCKETS: readonly Bucket[] = [
  { index: 0, label: "<$1M", min: 0, max: 1_000_000 - 1 },
  { index: 1, label: "$1M–$5M", min: 1_000_000, max: 5_000_000 - 1 },
  { index: 2, label: "$5M–$25M", min: 5_000_000, max: 25_000_000 - 1 },
  { index: 3, label: "$25M–$100M", min: 25_000_000, max: 100_000_000 - 1 },
  { index: 4, label: "$100M–$500M", min: 100_000_000, max: 500_000_000 - 1 },
  { index: 5, label: "$500M–$1B", min: 500_000_000, max: 1_000_000_000 - 1 },
  { index: 6, label: ">$1B", min: 1_000_000_000, max: Infinity },
];

export const HEADCOUNT_BUCKETS: readonly Bucket[] = [
  // min 0 rather than 1 so a data glitch never falls outside the table
  { index: 0, label: "1–10", min: 0, max: 10 },
  { index: 1, label: "11–50", min: 11, max: 50 },
  { index: 2, label: "51–200", min: 51, max: 200 },
  { index: 3, label: "201–500", min: 201, max: 500 },
  { index: 4, label: "501–1,000", min: 501, max: 1_000 },
  { index: 5, label: "1,001–5,000", min: 1_001, max: 5_000 },
  { index: 6, label: "5,001+", min: 5_001, max: Infinity },
];

/**
 * Total over non-negative numbers: every value lands in exactly one bucket. Values below the first
 * bucket's `min` clamp to the first bucket rather than falling through to the last.
 */
export function bucketOf(value: number, buckets: readonly Bucket[]): Bucket {
  const first = buckets[0]!;
  if (value < first.min) return first;
  for (const b of buckets) {
    if (value >= b.min && value <= b.max) return b;
  }
  return buckets[buckets.length - 1]!;
}
