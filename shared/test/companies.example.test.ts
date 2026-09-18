import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CompaniesFileSchema } from "../src/company.js";
import { regionOf } from "../src/regions.js";

const EXAMPLE = fileURLToPath(
  new URL("../../data/companies.example.json", import.meta.url),
);

describe("data/companies.example.json", () => {
  const raw: unknown = JSON.parse(readFileSync(EXAMPLE, "utf8"));
  const parsed = CompaniesFileSchema.safeParse(raw);

  it("validates against CompaniesFileSchema", () => {
    const problems = parsed.success
      ? []
      : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    expect(problems).toEqual([]);
  });

  it("schedules one company a day from 2026-01-01, so DEV_TODAY=2026-01-01 is puzzle #1", () => {
    if (!parsed.success) throw new Error("file does not validate");
    const { companies, startDate } = parsed.data;
    expect(companies.length).toBeGreaterThanOrEqual(30);
    expect(startDate).toBe("2026-01-01");
    expect(companies[0]!.date).toBe("2026-01-01");
    companies.forEach((c, i) => {
      const expected = new Date(Date.UTC(2026, 0, 1 + i))
        .toISOString()
        .slice(0, 10);
      expect(c.date, c.id).toBe(expected);
    });
  });

  it("keeps id == domain and region == regionOf(hqCountry)", () => {
    if (!parsed.success) throw new Error("file does not validate");
    for (const c of parsed.data.companies) {
      expect(c.id).toBe(c.domain);
      expect(c.id).toBe(c.id.toLowerCase());
      expect(c.region).toBe(regionOf(c.hqCountry));
    }
  });

  it("says in every record that the numbers are approximate", () => {
    if (!parsed.success) throw new Error("file does not validate");
    for (const c of parsed.data.companies) {
      expect(c.source?.notes ?? "").toMatch(/approximate/i);
    }
  });
});
