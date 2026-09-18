import { describe, expect, it } from "vitest";
import {
  BUSINESS_MODELS,
  FUNDING_STAGES,
  SECTORS,
} from "@venturedle/shared/server";
import { toEvidence } from "../src/evidence.js";
import {
  ExtractionSchema,
  createLlmClient,
  createMockLlmClient,
  mapFundingStage,
} from "../src/llm.js";
import type { Evidence } from "../src/evidence.js";

const klarna = toEvidence("klarna.com", {
  name: "Klarna",
  headcount: 4585,
  funding: {
    funding_total: 9460186174,
    funding_stage: "EXITED",
    funding_rounds: [{ funding_round_type: "IPO" }],
  },
  founding_date: { date: "2005-01-01" },
  location: { country: "Sweden" },
  tags_v2: ["Fintech", "Payments", "BNPL"],
  customer_type: "B2C",
});

function evidence(overrides: Partial<Evidence["funding"]>): Evidence {
  return { ...klarna, funding: { ...klarna.funding, ...overrides } };
}

describe("mock LLM provider", () => {
  const llm = createMockLlmClient();

  it("returns an extraction that satisfies the strict schema", async () => {
    const extraction = await llm.extract(klarna);
    expect(ExtractionSchema.parse(extraction)).toEqual(extraction);
  });

  it("normalises the categories from the evidence", async () => {
    expect(await llm.extract(klarna)).toMatchObject({
      sectors: ["Fintech", "Payments"], // "BNPL" is not in the taxonomy and is dropped
      businessModel: ["B2C"],
      hqCountry: "SE",
      foundedYear: 2005,
      fundingStage: "Public",
    });
  });

  it("is deterministic", async () => {
    expect(await llm.extract(klarna)).toEqual(await llm.extract(klarna));
  });

  it("never returns a value outside the taxonomies", async () => {
    for (const domain of ["a.com", "b.io", "c.dev", "d.co", "e.ai"]) {
      const extraction = await llm.extract(toEvidence(domain, {}));
      expect(SECTORS).toContain(extraction.sectors[0]);
      expect(BUSINESS_MODELS).toContain(extraction.businessModel[0]);
      expect(FUNDING_STAGES).toContain(extraction.fundingStage);
      expect(extraction.hqCountry).toMatch(/^[A-Z]{2}$/);
    }
  });

  it("is what `createLlmClient` returns for --provider mock, with no API key", () => {
    expect(createLlmClient({ provider: "mock" }).label).toBe("mock/mock");
  });
});

describe("mapFundingStage", () => {
  it.each([
    ["PRE_SEED", "Pre-seed"],
    ["SEED", "Seed"],
    ["SERIES_A", "Series A"],
    ["SERIES_B", "Series B"],
    ["SERIES_C", "Series C"],
    ["SERIES_D", "Series D+"],
    ["LATER_STAGE", "Series D+"],
    ["PRIVATE_EQUITY", "Series D+"],
  ])("%s → %s", (stageRaw, expected) => {
    expect(mapFundingStage(evidence({ stageRaw, roundTypes: [] }))).toBe(
      expected,
    );
  });

  it("splits EXITED by whether the company went public", () => {
    expect(
      mapFundingStage(evidence({ stageRaw: "EXITED", roundTypes: ["IPO"] })),
    ).toBe("Public");
    expect(
      mapFundingStage(
        evidence({ stageRaw: "EXITED", roundTypes: ["SERIES_C"] }),
      ),
    ).toBe("Acquired");
  });

  it("falls back to the funding total when the stage is unknown", () => {
    expect(
      mapFundingStage(evidence({ stageRaw: null, totalUsd: 1_000_000 })),
    ).toBe("Seed");
    expect(
      mapFundingStage(evidence({ stageRaw: null, totalUsd: 10_000_000 })),
    ).toBe("Series A");
    expect(
      mapFundingStage(evidence({ stageRaw: null, totalUsd: 50_000_000 })),
    ).toBe("Series C");
    expect(
      mapFundingStage(evidence({ stageRaw: null, totalUsd: 900_000_000 })),
    ).toBe("Series D+");
  });
});
