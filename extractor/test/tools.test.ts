import { describe, expect, it } from "vitest";
import { CompanySchema } from "@venturedle/shared/server";
import type { HarmonicFacts } from "../src/harmonic.js";
import type { Extraction } from "../src/llm.js";
import {
  addUtcDays,
  assignDates,
  buildRecord,
  isDomain,
  mapPool,
  normaliseDomain,
  parseDomainsFile,
} from "../src/tools.js";

describe("normaliseDomain", () => {
  it.each([
    ["klarna.com", "klarna.com"],
    ["  Klarna.COM  ", "klarna.com"],
    ["www.n26.com", "n26.com"],
    ["https://getmonzo.co.uk/about", "getmonzo.co.uk"],
    ["http://www.Revolut.com:8080/x?y=1#z", "revolut.com"],
    ["stripe.com.", "stripe.com"],
    ["klarna.com   # the Swedish one", "klarna.com"],
  ])("%s → %s", (raw, expected) => {
    expect(normaliseDomain(raw)).toBe(expected);
  });

  it.each(["", "   ", "# a comment", "  # indented comment"])(
    "returns null for %o",
    (raw) => {
      expect(normaliseDomain(raw)).toBeNull();
    },
  );
});

describe("isDomain", () => {
  it.each(["klarna.com", "getmonzo.co.uk", "acme-nodata.io", "a.b"])(
    "accepts %s",
    (value) => {
      expect(isDomain(value)).toBe(true);
    },
  );

  it.each([
    "klarna",
    "not a domain",
    "-klarna.com",
    "klarna-.com",
    "klarna..com",
  ])("rejects %o", (value) => {
    expect(isDomain(value)).toBe(false);
  });
});

describe("parseDomainsFile", () => {
  it("skips blanks and comments and keeps input order", () => {
    const domains = parseDomainsFile(
      [
        "# October",
        "klarna.com",
        "",
        "  ",
        "https://www.revolut.com/about",
        "n26.com",
      ].join("\n"),
    );
    expect(domains).toEqual(["klarna.com", "revolut.com", "n26.com"]);
  });

  it("rejects a duplicate that only appears after normalisation", () => {
    expect(() =>
      parseDomainsFile("klarna.com\nhttps://www.Klarna.com/eu\n"),
    ).toThrow(/line 2: duplicate domain "klarna.com" \(first seen on line 1\)/);
  });

  it("rejects a line that is not a domain", () => {
    expect(() => parseDomainsFile("klarna.com\nthe swedish one\n")).toThrow(
      /line 2/,
    );
  });

  it("rejects an empty file", () => {
    expect(() => parseDomainsFile("# nothing here\n")).toThrow(/no domains/);
  });
});

describe("addUtcDays", () => {
  it.each([
    ["2026-10-01", 0, "2026-10-01"],
    ["2026-10-01", 31, "2026-11-01"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2028-02-28", 1, "2028-02-29"],
    ["2026-03-28", 2, "2026-03-30"], // no DST: these are UTC days
  ])("%s + %i = %s", (date, days, expected) => {
    expect(addUtcDays(date, days)).toBe(expected);
  });

  it("rejects a non-date", () => {
    expect(() => addUtcDays("2026-02-30", 1)).toThrow();
  });
});

describe("assignDates", () => {
  const records = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("dates the survivors contiguously from start, in input order", () => {
    expect(assignDates(records, "2026-10-01")).toEqual([
      { id: "a", date: "2026-10-01" },
      { id: "b", date: "2026-10-02" },
      { id: "c", date: "2026-10-03" },
    ]);
  });

  it("never leaves a gap when a domain was rejected", () => {
    // "b" was rejected upstream, so it simply never reaches assignDates.
    const dates = assignDates([records[0]!, records[2]!], "2026-10-01").map(
      (r) => r.date,
    );
    expect(dates).toEqual(["2026-10-01", "2026-10-02"]);
  });

  it("does not mutate its input", () => {
    assignDates(records, "2026-10-01");
    expect(records[0]).toEqual({ id: "a" });
  });

  it("rejects an invalid start", () => {
    expect(() => assignDates(records, "01-10-2026")).toThrow(/--start/);
  });
});

describe("mapPool", () => {
  it("returns results in input order regardless of completion order", async () => {
    const delays = [30, 0, 20, 10, 0];
    const results = await mapPool(delays, 2, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(results).toEqual(delays);
  });

  it("never runs more than `limit` at once", async () => {
    let running = 0;
    let peak = 0;
    await mapPool([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
    });
    expect(peak).toBe(3);
  });
});

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
