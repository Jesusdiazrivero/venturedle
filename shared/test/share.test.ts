import { describe, expect, it } from "vitest";
import type { CellFeedback, GuessResult } from "../src/api.js";
import { buildShareText, formatElapsed } from "../src/scoring.js";

/** A GuessResult whose only interesting part is its row of colours. */
function row(colours: string, seq = 1): GuessResult {
  const cells: CellFeedback[] = [...colours].map((ch, i) => ({
    column: (
      [
        "sectors",
        "hqCountry",
        "foundedYear",
        "fundingStage",
        "totalFundingUsd",
        "headcount",
        "businessModel",
      ] as const
    )[i]!,
    color: ch === "G" ? "green" : ch === "Y" ? "yellow" : "grey",
    displayValue: "x",
  }));
  return {
    seq,
    guess: { id: "g", name: "G", logoUrl: "https://x/l.png" },
    cells,
    correct: false,
    at: "2026-01-01T00:00:00.000Z",
  };
}

describe("formatElapsed", () => {
  it.each([
    [0, "00:00"],
    [1_000, "00:01"],
    [61_000, "01:01"],
    [161_000, "02:41"],
    [599_000, "09:59"],
    [3_599_000, "59:59"],
    [3_600_000, "1:00:00"],
    [3_903_000, "1:05:03"],
    [45_000_000, "12:30:00"],
  ])("%d ms → %s", (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected);
  });

  it("truncates sub-second remainders and never goes negative", () => {
    expect(formatElapsed(1_999)).toBe("00:01");
    expect(formatElapsed(-5)).toBe("00:00");
  });
});

describe("buildShareText", () => {
  it("matches the format in docs/01-game-rules.md", () => {
    const text = buildShareText({
      number: 12,
      date: "2026-10-12",
      elapsedMs: 161_000,
      guesses: [
        row("GYWWGWY", 1),
        row("GGWYGWG", 2),
        row("GGGGGGG", 3),
        row("GGGGGGG", 4),
      ],
      publicUrl: "https://venturedle.example.com",
    });
    expect(text).toBe(
      [
        "Venturedle #12 · 2026-10-12 · 4 guesses · 02:41",
        "🟩🟨⬜⬜🟩⬜🟨",
        "🟩🟩⬜🟨🟩⬜🟩",
        "🟩🟩🟩🟩🟩🟩🟩",
        "🟩🟩🟩🟩🟩🟩🟩",
        "https://venturedle.example.com",
      ].join("\n"),
    );
  });

  it("says 'guess' in the singular for a one-guess solve", () => {
    const text = buildShareText({
      number: 1,
      date: "2026-01-01",
      elapsedMs: 4_000,
      guesses: [row("GGGGGGG")],
    });
    expect(text.split("\n")[0]).toBe(
      "Venturedle #1 · 2026-01-01 · 1 guess · 00:04",
    );
  });

  it("switches to h:mm:ss past an hour", () => {
    const text = buildShareText({
      number: 7,
      date: "2026-01-07",
      elapsedMs: 3_723_000,
      guesses: [row("GGGGGGG"), row("GGGGGGG", 2)],
    });
    expect(text.split("\n")[0]).toBe(
      "Venturedle #7 · 2026-01-07 · 2 guesses · 1:02:03",
    );
  });

  it("omits the URL line when publicUrl is unset", () => {
    const text = buildShareText({
      number: 3,
      date: "2026-01-03",
      elapsedMs: 1_000,
      guesses: [row("GGGGGGG")],
    });
    expect(text.split("\n")).toHaveLength(2);
    expect(text).not.toMatch(/http/);
  });

  it("emits one row per guess, seven emoji each, in guess order", () => {
    const text = buildShareText({
      number: 3,
      date: "2026-01-03",
      elapsedMs: 1_000,
      guesses: [row("WWWWWWW"), row("YYYYYYY", 2), row("GGGGGGG", 3)],
    });
    const rows = text.split("\n").slice(1);
    expect(rows).toEqual([
      "⬜⬜⬜⬜⬜⬜⬜",
      "🟨🟨🟨🟨🟨🟨🟨",
      "🟩🟩🟩🟩🟩🟩🟩",
    ]);
    for (const r of rows) expect([...r]).toHaveLength(7);
  });

  it("leaks nothing about the answer beyond the colours", () => {
    const text = buildShareText({
      number: 3,
      date: "2026-01-03",
      elapsedMs: 1_000,
      guesses: [row("GYWGYWG")],
    });
    for (const line of text.split("\n").slice(1)) {
      expect([...line].every((ch) => ["🟩", "🟨", "⬜"].includes(ch))).toBe(
        true,
      );
    }
  });
});
