import { describe, expect, it } from "vitest";
import { REGIONS, REGION_BY_COUNTRY, regionOf } from "../src/regions.js";

describe("regionOf", () => {
  it.each([
    ["ES", "Europe"],
    ["SE", "Europe"],
    ["US", "North America"],
    ["BR", "South America"],
    ["IL", "Middle East"],
    ["NG", "Africa"],
    ["SG", "Asia"],
    ["AU", "Oceania"],
  ])("%s → %s", (country, region) => {
    expect(regionOf(country)).toBe(region);
  });

  it("returns 'Other' for an unknown code", () => {
    expect(regionOf("ZZ")).toBe("Other");
    expect(regionOf("")).toBe("Other");
  });

  it("accepts a lowercase code", () => {
    expect(regionOf("es")).toBe("Europe");
  });

  it("only ever returns a value from REGIONS", () => {
    for (const region of Object.values(REGION_BY_COUNTRY)) {
      expect(REGIONS).toContain(region);
    }
  });

  it("maps every code with a two-letter uppercase key", () => {
    for (const code of Object.keys(REGION_BY_COUNTRY)) {
      expect(code).toMatch(/^[A-Z]{2}$/);
    }
  });
});
