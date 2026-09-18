/**
 * The LLM test double. It lives here, in `test/`, and not in `src/`: the shipped extractor has no
 * fake provider. `extract(options, clients)` takes it directly.
 */
import type { Evidence } from "../src/harmonic.js";
import {
  LlmInvalidOutputError,
  type Extraction,
  type LlmClient,
} from "../src/llm.js";

/** Canned categories for the fixture companies; anything else gets the fallback. */
const BY_DOMAIN: Record<
  string,
  Pick<Extraction, "sectors" | "businessModel" | "hqCountry">
> = {
  "klarna.com": {
    sectors: ["Fintech", "Payments"],
    businessModel: ["B2C"],
    hqCountry: "SE",
  },
  "revolut.com": {
    sectors: ["Fintech"],
    businessModel: ["B2C", "B2B"],
    hqCountry: "GB",
  },
  "n26.com": {
    sectors: ["Fintech", "Payments"],
    businessModel: ["B2C"],
    hqCountry: "DE",
  },
};

const FALLBACK = {
  sectors: ["Enterprise Software"],
  businessModel: ["B2B"],
  hqCountry: "US",
} satisfies Pick<Extraction, "sectors" | "businessModel" | "hqCountry">;

export interface FakeLlmOptions {
  /** domains for which the model keeps returning something the schema rejects */
  invalidFor?: readonly string[];
  /** domains the model is unsure about */
  lowConfidenceFor?: readonly string[];
}

export interface FakeLlm extends LlmClient {
  /** every domain the pipeline actually asked about (order is a race — sort before asserting) */
  readonly calls: string[];
}

export function createFakeLlm(options: FakeLlmOptions = {}): FakeLlm {
  const calls: string[] = [];
  return {
    label: "fake/fake",
    calls,
    async extract(evidence: Evidence): Promise<Extraction> {
      calls.push(evidence.domain);
      if (options.invalidFor?.includes(evidence.domain)) {
        throw new LlmInvalidOutputError("sectors: invalid enum value");
      }
      return {
        ...(BY_DOMAIN[evidence.domain] ?? FALLBACK),
        foundedYear: evidence.foundingDate
          ? Number(evidence.foundingDate.slice(0, 4))
          : null,
        fundingStage: "Series D+",
        confidence: options.lowConfidenceFor?.includes(evidence.domain)
          ? "low"
          : "high",
        notes: "canned test extraction",
      };
    },
  };
}
