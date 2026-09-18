import { describe, expect, it } from "vitest";
import {
  CompaniesFileSchema,
  CompanySchema,
  isCalendarDate,
} from "../src/company.js";

const KLARNA = {
  id: "klarna.com",
  date: "2026-10-01",
  domain: "klarna.com",
  name: "Klarna",
  logoUrl: "https://assets.example.com/klarna.png",
  sectors: ["Fintech", "Payments"],
  businessModel: ["B2C", "B2B2C"],
  hqCountry: "SE",
  region: "Europe",
  foundedYear: 2005,
  fundingStage: "Public",
  totalFundingUsd: 9_460_186_174,
  headcount: 4585,
  source: {
    harmonicId: 425798,
    llm: "anthropic/claude-sonnet-4-5",
    notes: "approximate",
  },
};

const REVOLUT = {
  ...KLARNA,
  id: "revolut.com",
  date: "2026-10-02",
  domain: "revolut.com",
  name: "Revolut",
  hqCountry: "GB",
  region: "Europe",
  foundedYear: 2015,
  fundingStage: "Series D+",
  totalFundingUsd: 2_000_000_000,
  headcount: 10_000,
  source: undefined,
};

function file(companies: unknown[]) {
  return {
    version: 1,
    generatedAt: "2026-09-18T10:12:33Z",
    startDate: "2026-10-01",
    companies,
  };
}

/** The first message zod produces, so a failure says which rule bit. */
function failure(
  value: unknown,
  schema: typeof CompanySchema | typeof CompaniesFileSchema,
) {
  const r = schema.safeParse(value);
  expect(r.success).toBe(false);
  return r.success
    ? ""
    : r.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join(" | ");
}

describe("isCalendarDate", () => {
  it.each(["2026-01-01", "2026-12-31", "2024-02-29"])("accepts %s", (d) => {
    expect(isCalendarDate(d)).toBe(true);
  });
  it.each([
    "2026-02-30",
    "2026-13-01",
    "2026-1-1",
    "20260101",
    "not a date",
    "",
  ])("rejects %s", (d) => {
    expect(isCalendarDate(d)).toBe(false);
  });
});

describe("CompanySchema", () => {
  it("accepts a well-formed record", () => {
    expect(CompanySchema.safeParse(KLARNA).success).toBe(true);
  });

  it("rejects a region that is not regionOf(hqCountry)", () => {
    expect(failure({ ...KLARNA, region: "Asia" }, CompanySchema)).toMatch(
      /region/,
    );
  });

  it("rejects an unknown sector", () => {
    expect(failure({ ...KLARNA, sectors: ["BNPL"] }, CompanySchema)).toMatch(
      /sectors/,
    );
  });

  it("rejects an unknown funding stage", () => {
    expect(
      failure({ ...KLARNA, fundingStage: "Series E" }, CompanySchema),
    ).toMatch(/fundingStage/);
  });

  it("rejects an unknown business model", () => {
    expect(
      failure({ ...KLARNA, businessModel: ["D2C"] }, CompanySchema),
    ).toMatch(/businessModel/);
  });

  it("rejects zero sectors and more than three", () => {
    expect(failure({ ...KLARNA, sectors: [] }, CompanySchema)).toMatch(
      /sectors/,
    );
    expect(
      failure(
        { ...KLARNA, sectors: ["Fintech", "Payments", "Consumer", "Social"] },
        CompanySchema,
      ),
    ).toMatch(/sectors/);
  });

  it("rejects a repeated sector", () => {
    expect(
      failure({ ...KLARNA, sectors: ["Fintech", "Fintech"] }, CompanySchema),
    ).toMatch(/repeat a sector/);
  });

  it("rejects a lowercase or three-letter country code", () => {
    expect(failure({ ...KLARNA, hqCountry: "se" }, CompanySchema)).toMatch(
      /hqCountry/,
    );
    expect(failure({ ...KLARNA, hqCountry: "SWE" }, CompanySchema)).toMatch(
      /hqCountry/,
    );
  });

  it("rejects a non-https logo URL", () => {
    expect(
      failure(
        { ...KLARNA, logoUrl: "http://example.com/a.png" },
        CompanySchema,
      ),
    ).toMatch(/logoUrl/);
  });

  it("rejects a founded year outside [1800, this year]", () => {
    expect(failure({ ...KLARNA, foundedYear: 1799 }, CompanySchema)).toMatch(
      /foundedYear/,
    );
    expect(
      failure(
        { ...KLARNA, foundedYear: new Date().getUTCFullYear() + 1 },
        CompanySchema,
      ),
    ).toMatch(/foundedYear/);
  });

  it("rejects non-integer or negative numbers", () => {
    expect(failure({ ...KLARNA, headcount: -1 }, CompanySchema)).toMatch(
      /headcount/,
    );
    expect(failure({ ...KLARNA, totalFundingUsd: 1.5 }, CompanySchema)).toMatch(
      /totalFundingUsd/,
    );
  });

  it("accepts a zero-funding, zero-headcount company", () => {
    expect(
      CompanySchema.safeParse({ ...KLARNA, totalFundingUsd: 0, headcount: 0 })
        .success,
    ).toBe(true);
  });

  it("rejects an impossible date", () => {
    expect(failure({ ...KLARNA, date: "2026-02-30" }, CompanySchema)).toMatch(
      /date/,
    );
  });

  it("treats source as optional", () => {
    const { source: _source, ...withoutSource } = KLARNA;
    expect(CompanySchema.safeParse(withoutSource).success).toBe(true);
  });
});

describe("CompaniesFileSchema", () => {
  it("accepts a well-formed file", () => {
    expect(CompaniesFileSchema.safeParse(file([KLARNA, REVOLUT])).success).toBe(
      true,
    );
  });

  it("allows gaps between dates", () => {
    const later = { ...REVOLUT, date: "2026-11-15" };
    expect(CompaniesFileSchema.safeParse(file([KLARNA, later])).success).toBe(
      true,
    );
  });

  it("rejects an empty company list", () => {
    expect(failure(file([]), CompaniesFileSchema)).toMatch(/companies/);
  });

  it("rejects a duplicate date", () => {
    const clash = { ...REVOLUT, date: KLARNA.date };
    expect(failure(file([KLARNA, clash]), CompaniesFileSchema)).toMatch(
      /duplicate date/,
    );
  });

  it("rejects a duplicate id", () => {
    const clash = { ...REVOLUT, id: KLARNA.id };
    expect(failure(file([KLARNA, clash]), CompaniesFileSchema)).toMatch(
      /duplicate id/,
    );
  });

  it("rejects unsorted dates", () => {
    expect(failure(file([REVOLUT, KLARNA]), CompaniesFileSchema)).toMatch(
      /sorted by date/,
    );
  });

  it("rejects a wrong region inside the list", () => {
    expect(
      failure(
        file([KLARNA, { ...REVOLUT, region: "Africa" }]),
        CompaniesFileSchema,
      ),
    ).toMatch(/region/);
  });

  it("rejects an unknown sector inside the list", () => {
    expect(
      failure(
        file([KLARNA, { ...REVOLUT, sectors: ["Neobanking"] }]),
        CompaniesFileSchema,
      ),
    ).toMatch(/sectors/);
  });

  it("rejects a version other than 1", () => {
    expect(
      failure({ ...file([KLARNA]), version: 2 }, CompaniesFileSchema),
    ).toMatch(/version/);
  });
});
