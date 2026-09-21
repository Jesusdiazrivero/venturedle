import { describe, expect, it } from "vitest";
import type { Leaderboard } from "@venturedle/shared/server";
import { DAY2, DAY3, createTestApp, type TestApp } from "./helpers.js";

const POOL = ["alpha.com", "beta.com", "gamma.com", "beta-twin.com"];
const ANSWER_ON: Record<string, string> = {
  [DAY2]: "beta.com",
  [DAY3]: "gamma.com",
};

function guesser(t: TestApp, token: string) {
  return (companyId: string) =>
    t.request("/api/results/today/guesses", {
      method: "POST",
      token,
      body: JSON.stringify({ companyId }),
    });
}

/**
 * Sign up, start, spend `wrongGuesses` on companies that are not the answer, wait `solveAfterMs`
 * and win. The clock is rewound afterwards so that several players can solve "at the same time"
 * and produce the ties the ranking has to handle.
 */
async function solve(
  t: TestApp,
  nickname: string,
  { wrongGuesses = 0, solveAfterMs = 1_000 } = {},
): Promise<string> {
  const answer = ANSWER_ON[t.config.devToday!]!;
  const token = await t.signUp(nickname);
  const guess = guesser(t, token);

  await t.request("/api/results/today/start", { method: "POST", token });
  for (const id of POOL.filter((id) => id !== answer).slice(0, wrongGuesses)) {
    await guess(id);
  }
  t.advance(solveAfterMs);
  await guess(answer);
  t.advance(-solveAfterMs);
  return token;
}

async function board(
  t: TestApp,
  query: string,
  token?: string,
): Promise<Leaderboard> {
  const res = await t.request(
    `/api/leaderboard?${query}`,
    token ? { token } : {},
  );
  return (await res.json()) as Leaderboard;
}

describe("today", () => {
  it("orders by guesses then time, and by time then guesses", async () => {
    const t = createTestApp();
    await solve(t, "Ana", { wrongGuesses: 2, solveAfterMs: 5_000 });
    await solve(t, "Ben", { wrongGuesses: 2, solveAfterMs: 3_000 });
    await solve(t, "Cleo", { wrongGuesses: 0, solveAfterMs: 9_000 });

    const byGuesses = await board(t, "scope=today&by=guesses");
    expect(byGuesses.scope).toBe("today");
    expect(byGuesses.date).toBe(DAY2);
    expect(
      byGuesses.rows.map((r) => [
        r.rank,
        r.player.nickname,
        r.guesses,
        r.elapsedMs,
      ]),
    ).toEqual([
      [1, "Cleo", 1, 9_000],
      [2, "Ben", 3, 3_000],
      [3, "Ana", 3, 5_000],
    ]);
    expect(byGuesses.rows.every((r) => r.daysSolved === undefined)).toBe(true);

    const byTime = await board(t, "scope=today&by=time");
    expect(byTime.rows.map((r) => r.player.nickname)).toEqual([
      "Ben",
      "Ana",
      "Cleo",
    ]);
  });

  it("defaults to today by guesses and ignores nonsense query values", async () => {
    const t = createTestApp();
    await solve(t, "Ana");
    const defaulted = await board(t, "");
    expect(defaulted).toMatchObject({ scope: "today", by: "guesses" });
    expect(await board(t, "scope=weekly&by=vibes")).toMatchObject({
      scope: "today",
      by: "guesses",
    });
  });

  it("gives tied players the same rank", async () => {
    const t = createTestApp();
    await solve(t, "Ana", { solveAfterMs: 4_000 });
    await solve(t, "Ben", { solveAfterMs: 4_000 });
    await solve(t, "Cleo", { wrongGuesses: 1, solveAfterMs: 4_000 });

    const rows = (await board(t, "scope=today")).rows;
    expect(rows.map((r) => r.rank)).toEqual([1, 1, 3]);
  });

  it("marks the caller and leaves `me` out when they are already listed", async () => {
    const t = createTestApp();
    await solve(t, "Ana");
    const mine = await solve(t, "Ben");

    const listed = await board(t, "scope=today", mine);
    expect(
      listed.rows.filter((r) => r.isMe).map((r) => r.player.nickname),
    ).toEqual(["Ben"]);
    expect(listed.me).toBeUndefined();

    // Unauthenticated: the same rows, nobody flagged.
    expect((await board(t, "scope=today")).rows.some((r) => r.isMe)).toBe(
      false,
    );
  });

  it("appends `me` when the caller is outside the top 50", async () => {
    const t = createTestApp();
    // 50 players solve in one guess at the same instant, so they all tie at rank 1.
    for (let i = 0; i < 50; i++) await solve(t, `P${i}`);
    const mine = await solve(t, "Lastly", { wrongGuesses: 3 });

    const listed = await board(t, "scope=today", mine);
    expect(listed.rows).toHaveLength(50);
    expect(listed.rows.some((r) => r.isMe)).toBe(false);
    expect(listed.me).toMatchObject({
      rank: 51,
      isMe: true,
      guesses: 4,
      player: { nickname: "Lastly" },
    });
  });
});

describe("all time", () => {
  it("averages guesses and time over the days solved", async () => {
    const t = createTestApp();
    await solve(t, "Ana", { solveAfterMs: 1_000 });
    await solve(t, "Ben", { wrongGuesses: 1, solveAfterMs: 2_000 });

    t.setToday(DAY3);
    const ana = await solve(t, "Ana2", {
      wrongGuesses: 2,
      solveAfterMs: 4_000,
    });

    const byGuesses = await board(t, "scope=alltime&by=guesses", ana);
    expect(byGuesses.date).toBeUndefined();
    expect(
      byGuesses.rows.map((r) => [
        r.player.nickname,
        r.guesses,
        r.elapsedMs,
        r.daysSolved,
      ]),
    ).toEqual([
      ["Ana", 1, 1_000, 1],
      ["Ben", 2, 2_000, 1],
      ["Ana2", 3, 4_000, 1],
    ]);

    const byTime = await board(t, "scope=alltime&by=time");
    expect(byTime.rows.map((r) => r.player.nickname)).toEqual([
      "Ana",
      "Ben",
      "Ana2",
    ]);
  });

  it("rounds a multi-day average to two decimals", async () => {
    const t = createTestApp();
    const token = await t.signUp("Ana");
    const guess = guesser(t, token);
    const start = () =>
      t.request("/api/results/today/start", { method: "POST", token });

    await start();
    t.advance(1_000);
    await guess("beta.com"); // day 2 in one guess, 1 s

    t.setToday(DAY3);
    await start();
    await guess("alpha.com");
    await guess("beta.com");
    t.advance(2_000);
    await guess("gamma.com"); // day 3 in three guesses, 2 s

    const rows = (await board(t, "scope=alltime")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      guesses: 2,
      elapsedMs: 1_500,
      daysSolved: 2,
    });
  });
});
