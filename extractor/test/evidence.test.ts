import { describe, expect, it } from "vitest";
import { toEvidence, toFacts } from "../src/evidence.js";

const snake = {
  id: 481523,
  name: "Klarna",
  logo_url: "https://assets.harmonic.ai/klarna.png",
  description: "Klarna offers a global payments network.",
  website: { domain: "klarna.com" },
  headcount: 4585,
  funding: {
    funding_total: 9460186174,
    funding_stage: "EXITED",
    funding_rounds: [
      { funding_round_type: "SERIES_A" },
      { funding_round_type: "IPO" },
    ],
  },
  founding_date: { date: "2005-01-01" },
  location: { country: "Sweden", state: "Stockholm County", city: "Stockholm" },
  tags_v2: ["Fintech", "Payments"],
  customer_type: "B2C",
};

const camel = {
  id: 481523,
  name: "Klarna",
  logoUrl: "https://assets.harmonic.ai/klarna.png",
  description: "Klarna offers a global payments network.",
  website: { domain: "klarna.com" },
  headcount: 4585,
  funding: {
    fundingTotal: 9460186174,
    fundingStage: "EXITED",
    fundingRounds: [
      { fundingRoundType: "SERIES_A" },
      { fundingRoundType: "IPO" },
    ],
  },
  foundingDate: { date: "2005-01-01" },
  location: { country: "Sweden", state: "Stockholm County", city: "Stockholm" },
  tagsV2: ["Fintech", "Payments"],
  customerType: "B2C",
};

describe("toEvidence", () => {
  it("produces the same evidence from snake_case and camelCase", () => {
    expect(toEvidence("klarna.com", camel)).toEqual(
      toEvidence("klarna.com", snake),
    );
  });

  it("maps every field we care about", () => {
    expect(toEvidence("klarna.com", snake)).toEqual({
      domain: "klarna.com",
      name: "Klarna",
      description: "Klarna offers a global payments network.",
      tags: ["Fintech", "Payments"],
      customerType: "B2C",
      location: {
        country: "Sweden",
        state: "Stockholm County",
        city: "Stockholm",
      },
      foundingDate: "2005-01-01",
      funding: {
        stageRaw: "EXITED",
        totalUsd: 9460186174,
        roundTypes: ["SERIES_A", "IPO"],
      },
      headcount: 4585,
    });
  });

  it("flattens tags_v2 given as objects", () => {
    const raw = {
      ...snake,
      tags_v2: [
        { type: "INDUSTRY", display_value: "Fintech" },
        { type: "PRODUCT", displayValue: "Payments" },
        { type: "EMPTY" },
      ],
    };
    expect(toEvidence("klarna.com", raw).tags).toEqual(["Fintech", "Payments"]);
  });

  it("de-duplicates tags", () => {
    expect(
      toEvidence("klarna.com", { ...snake, tags_v2: ["Fintech", "Fintech"] })
        .tags,
    ).toEqual(["Fintech"]);
  });

  it("joins an array customer_type", () => {
    expect(
      toEvidence("x.com", { ...snake, customer_type: ["B2C", "B2B"] })
        .customerType,
    ).toBe("B2C, B2B");
  });

  it("trims an ISO timestamp founding date to a calendar date", () => {
    expect(
      toEvidence("x.com", {
        ...snake,
        founding_date: { date: "2005-01-01T00:00:00Z" },
      }).foundingDate,
    ).toBe("2005-01-01");
  });

  it("nulls everything missing rather than inventing it", () => {
    expect(toEvidence("ghost.com", {})).toEqual({
      domain: "ghost.com",
      name: "Ghost", // the only fallback: the domain label
      description: null,
      tags: [],
      customerType: null,
      location: { country: null, state: null, city: null },
      foundingDate: null,
      funding: { stageRaw: null, totalUsd: null, roundTypes: [] },
      headcount: null,
    });
  });
});

describe("toFacts", () => {
  it("reads the numbers from either casing", () => {
    expect(toFacts("klarna.com", camel)).toEqual(toFacts("klarna.com", snake));
    expect(toFacts("klarna.com", snake)).toEqual({
      harmonicId: 481523,
      name: "Klarna",
      logoUrl: "https://assets.harmonic.ai/klarna.png",
      headcount: 4585,
      totalFundingUsd: 9460186174,
      foundedYear: 2005,
    });
  });

  it("falls back to a favicon when Harmonic has no logo", () => {
    expect(toFacts("klarna.com", { ...snake, logo_url: null }).logoUrl).toBe(
      "https://www.google.com/s2/favicons?domain=klarna.com&sz=128",
    );
  });

  it("accepts a funding total serialised as a string", () => {
    expect(
      toFacts("x.com", { funding: { funding_total: "12000000" } })
        .totalFundingUsd,
    ).toBe(12_000_000);
  });

  it("reports missing numbers as null — they are never guessed", () => {
    const facts = toFacts("ghost.com", { id: 1, name: "Ghost" });
    expect(facts.headcount).toBeNull();
    expect(facts.totalFundingUsd).toBeNull();
    expect(facts.foundedYear).toBeNull();
  });
});
