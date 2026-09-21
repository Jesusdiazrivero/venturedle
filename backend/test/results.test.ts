import { describe, expect, it } from "vitest";
import type { HealthResponse, PlayState } from "@venturedle/shared/server";
import { COMPANIES, DAY2, createTestApp, type TestApp } from "./helpers.js";

async function state(res: Response): Promise<PlayState> {
  return (await res.json()) as PlayState;
}

function play(t: TestApp, token: string) {
  return {
    get: () => t.request("/api/results/today", { token }),
    start: () =>
      t.request("/api/results/today/start", { method: "POST", token }),
    guess: (companyId: string) =>
      t.request("/api/results/today/guesses", {
        method: "POST",
        token,
        body: JSON.stringify({ companyId }),
      }),
  };
}

describe("starting", () => {
  it("reports not_started before the first call, with today's puzzle number", async () => {
    const t = createTestApp();
    const p = play(t, await t.signUp("Jess"));
    const before = await state(await p.get());
    expect(before).toEqual({
      date: DAY2,
      number: 2,
      status: "not_started",
      guesses: [],
    });
  });

  it("is idempotent: a second start does not reset the clock", async () => {
    const t = createTestApp();
    const p = play(t, await t.signUp("Jess"));

    const first = await state(await p.start());
    expect(first.status).toBe("playing");
    expect(first.startedAt).toBe("2026-03-02T09:00:00.000Z");

    t.advance(120_000);
    const second = await state(await p.start());
    expect(second.startedAt).toBe(first.startedAt);
  });

  it("404s when nothing is scheduled for today", async () => {
    const t = createTestApp({ today: "2026-06-01" });
    const p = play(t, await t.signUp("Jess"));
    for (const res of [
      await p.get(),
      await p.start(),
      await p.guess("beta.com"),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: "no_puzzle_today" });
    }
  });
});

describe("guessing", () => {
  it("keeps the answer hidden until the win, then returns it with the share text", async () => {
    const t = createTestApp({ publicUrl: "https://venturedle.example.com" });
    const p = play(t, await t.signUp("Jess"));
    await p.start();

    t.advance(30_000);
    const miss = await state(await p.guess("gamma.com"));
    expect(miss.status).toBe("playing");
    expect(miss.answer).toBeUndefined();
    expect(miss.shareText).toBeUndefined();
    expect(miss.guesses).toHaveLength(1);
    expect(miss.guesses[0]).toMatchObject({
      seq: 1,
      correct: false,
      guess: { id: "gamma.com", name: "Gamma" },
    });
    expect(miss.guesses[0]!.cells.map((c) => c.color)).toEqual([
      "grey", // sectors
      "grey", // hqCountry (US vs SE, different regions)
      "grey", // foundedYear
      "grey", // fundingStage (Seed is three steps from Series C)
      "grey", // totalFundingUsd
      "grey", // headcount
      "grey", // businessModel
    ]);

    t.advance(65_000);
    const win = await state(await p.guess("beta.com"));
    expect(win.status).toBe("solved");
    expect(win.answer).toEqual({
      id: "beta.com",
      name: "Beta",
      logoUrl: "https://example.com/beta.png",
    });
    expect(win.elapsedMs).toBe(95_000);
    expect(win.solvedAt).toBe("2026-03-02T09:01:35.000Z");
    expect(win.shareText).toBe(
      [
        "Venturedle #2 · 2026-03-02 · 2 guesses · 01:35",
        "⬜⬜⬜⬜⬜⬜⬜",
        "🟩🟩🟩🟩🟩🟩🟩",
        "https://venturedle.example.com",
      ].join("\n"),
    );
  });

  it("starts the play itself when the first guess arrives without one", async () => {
    const t = createTestApp();
    const p = play(t, await t.signUp("Jess"));
    const after = await state(await p.guess("alpha.com"));
    expect(after.status).toBe("playing");
    expect(after.startedAt).toBe("2026-03-02T09:00:00.000Z");
  });

  it("409s the same company twice and 400s one that is not in the pool", async () => {
    const t = createTestApp();
    const p = play(t, await t.signUp("Jess"));
    await p.guess("alpha.com");

    const again = await p.guess("alpha.com");
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "already_guessed" });

    const unknown = await p.guess("stripe.com");
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: "unknown_company" });

    const malformed = await t.request("/api/results/today/guesses", {
      method: "POST",
      token: await t.signUp("Sam"),
      body: JSON.stringify({ company: "alpha.com" }),
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid_body" });

    // Still only the one guess on record.
    expect((await state(await p.get())).guesses).toHaveLength(1);
  });

  it("treats a guess after the solve as a 200 no-op", async () => {
    const t = createTestApp();
    const p = play(t, await t.signUp("Jess"));
    const solved = await state(await p.guess("beta.com"));
    expect(solved.status).toBe("solved");

    t.advance(600_000);
    const res = await p.guess("gamma.com");
    expect(res.status).toBe(200);
    const after = await state(res);
    expect(after).toEqual(solved);
  });

  it("scores an identical seven-tuple all green and still calls it a miss", async () => {
    const t = createTestApp();
    const p = play(t, await t.signUp("Jess"));
    const after = await state(await p.guess("beta-twin.com"));

    expect(after.guesses[0]!.cells.every((c) => c.color === "green")).toBe(
      true,
    );
    expect(after.guesses[0]!.correct).toBe(false);
    expect(after.status).toBe("playing");
    expect(after.answer).toBeUndefined();
  });

  it("never lets one player's guess touch another's play", async () => {
    const t = createTestApp();
    const jess = play(t, await t.signUp("Jess"));
    const sam = play(t, await t.signUp("Sam"));

    await jess.guess("alpha.com");
    expect((await state(await sam.get())).status).toBe("not_started");
    expect((await state(await sam.guess("alpha.com"))).guesses).toHaveLength(1);
  });
});

describe("stored plays are immutable history", () => {
  it("survives renaming, deleting and re-numbering companies in the file", async () => {
    const t = createTestApp({ publicUrl: "https://venturedle.example.com" });
    const p = play(t, await t.signUp("Jess"));
    await p.start();
    t.advance(10_000);
    await p.guess("gamma.com");
    const solved = await state(await p.guess("beta.com"));
    expect(solved.number).toBe(2);

    // Delete the first company (so beta would now be #1) and rename beta and gamma.
    t.writeCompanies([
      {
        ...COMPANIES[1]!,
        name: "Beta Renamed",
        logoUrl: "https://example.com/new.png",
      },
      { ...COMPANIES[2]!, name: "Gamma Renamed" },
      COMPANIES[3]!,
    ]);
    t.advance(31_000);
    const health = (await (
      await t.request("/api/health")
    ).json()) as HealthResponse;
    expect(health.companies).toBe(3);

    const after = await state(await p.get());
    expect(after).toEqual(solved);
    expect(after.number).toBe(2);
    expect(after.answer!.name).toBe("Beta");
    expect(after.guesses[0]!.guess.name).toBe("Gamma");
  });
});
