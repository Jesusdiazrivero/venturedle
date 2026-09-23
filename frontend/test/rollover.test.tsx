import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlayState, PuzzleInfo } from "@venturedle/shared";
import { App } from "../src/App.js";
import { setToken } from "../src/session.js";
import { fakeApi } from "./fake-api.js";
import { POOL } from "./fixtures.js";

const MIDNIGHT = Date.parse("2026-10-13T00:00:00.000Z");

function puzzleOn(day: 12 | 13): PuzzleInfo {
  return {
    date: `2026-10-${day}`,
    exists: true,
    number: day,
    nextPuzzleAt: `2026-10-${day + 1}T00:00:00.000Z`,
  };
}

function notStarted(day: 12 | 13): PlayState {
  return {
    date: `2026-10-${day}`,
    number: day,
    status: "not_started",
    guesses: [],
  };
}

/** Advance the fake clock and let every promise it releases settle. */
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("midnight rollover", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: MIDNIGHT - 2_000 });
    setToken("a-token");
  });

  afterEach(() => {
    vi.useRealTimers();
    setToken(null);
  });

  it("fetches the new puzzle when the countdown runs out, and keeps asking until the server agrees", async () => {
    // The server's day turns over a beat after ours does: the first ask still answers "the 12th".
    let serverDay: 12 | 13 = 12;
    const api = fakeApi({
      "GET /api/config": () => ({ authMode: "anonymous" }),
      "GET /api/me": () => ({ id: "p1", nickname: "tester" }),
      "GET /api/puzzle/today": () => puzzleOn(serverDay),
      "GET /api/companies": () => POOL,
      "GET /api/results/today": () => notStarted(serverDay),
      "POST /api/results/today/start": () => ({
        ...notStarted(serverDay),
        status: "playing",
        startedAt: "2026-10-13T00:00:05.000Z",
      }),
    });

    render(<App />);
    await tick(0);
    expect(screen.getByText(/#12/)).toBeDefined();

    // Our clock reaches midnight first — we ask, and get yesterday back.
    await tick(2_000);
    expect(screen.getByText(/#12/)).toBeDefined();

    serverDay = 13;
    await tick(5_000);
    expect(screen.getByText(/#13 · 2026-10-13 UTC/)).toBeDefined();
    // The board is the new day's, not yesterday's grid re-labelled.
    expect(screen.getByText(/0 guesses/)).toBeDefined();
    expect(
      api.calls.filter((c) => c === "POST /api/results/today/start"),
    ).toHaveLength(2);

    // And the poll stops once the day has moved on.
    const asks = api.calls.filter((c) => c === "GET /api/puzzle/today").length;
    await tick(30_000);
    expect(api.calls.filter((c) => c === "GET /api/puzzle/today")).toHaveLength(
      asks,
    );
  });
});
