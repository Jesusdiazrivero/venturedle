import { describe, expect, it } from "vitest";
import { addUtcDays, assignDates } from "../src/schedule.js";

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
