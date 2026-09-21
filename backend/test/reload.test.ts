import { describe, expect, it, vi } from "vitest";
import type { HealthResponse, PuzzleInfo } from "@venturedle/shared/server";
import { COMPANIES, DAY4, createTestApp, type TestApp } from "./helpers.js";

async function count(t: TestApp): Promise<number> {
  return ((await (await t.request("/api/health")).json()) as HealthResponse)
    .companies;
}

describe("companies.json reload", () => {
  it("picks up a new schedule without a restart", async () => {
    const t = createTestApp();
    expect(await count(t)).toBe(4);

    t.writeCompanies(COMPANIES.slice(0, 3));
    t.advance(31_000);
    expect(await count(t)).toBe(3);
  });

  it("checks at most every 30 s", async () => {
    const t = createTestApp();
    expect(await count(t)).toBe(4); // the first request is the first check
    t.writeCompanies(COMPANIES.slice(0, 2));

    t.advance(29_000);
    expect(await count(t)).toBe(4);
    t.advance(2_000);
    expect(await count(t)).toBe(2);
  });

  it("keeps the previous schedule when the new file does not parse", async () => {
    const t = createTestApp();
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});

    t.writeRaw("{ not json");
    t.advance(31_000);
    expect(await count(t)).toBe(4);

    // …and when it parses but fails the schema (two companies on the same date).
    t.writeCompanies([
      COMPANIES[0]!,
      { ...COMPANIES[1]!, date: COMPANIES[0]!.date },
    ]);
    t.advance(31_000);
    expect(await count(t)).toBe(4);
    expect(warn).toHaveBeenCalledTimes(2);

    // A later good file still gets picked up — a bad one does not poison the loader.
    t.writeCompanies(COMPANIES.slice(0, 1));
    t.advance(31_000);
    expect(await count(t)).toBe(1);
    warn.mockRestore();
  });

  it("re-dates the puzzle when the schedule moves", async () => {
    const t = createTestApp();
    expect(
      ((await (await t.request("/api/puzzle/today")).json()) as PuzzleInfo)
        .number,
    ).toBe(2);

    // Today's company is gone; the twin now holds the last slot alone.
    t.writeCompanies([COMPANIES[0]!, COMPANIES[2]!, COMPANIES[3]!]);
    t.advance(31_000);
    const info = (await (
      await t.request("/api/puzzle/today")
    ).json()) as PuzzleInfo;
    expect(info.exists).toBe(false);

    t.setToday(DAY4);
    const twin = (await (
      await t.request("/api/puzzle/today")
    ).json()) as PuzzleInfo;
    expect(twin).toMatchObject({ exists: true, number: 3 });
  });
});
