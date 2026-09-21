/**
 * The play endpoints. All three are implicitly "today" (D11) and all three answer with a full
 * `PlayState`, so the SPA never has to merge a partial response into what it already has.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { ApiError } from "@venturedle/shared/server";
import { requireAuth } from "../auth.js";
import type { AppEnv, Deps } from "../config.js";
import {
  buildPlayState,
  recordGuess,
  startPlay,
  type Puzzle,
} from "../play.js";
import { today } from "../time.js";

const GuessBody = z.object({ companyId: z.string() });

export function resultsRoutes(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", requireAuth);

  /** Today's date and puzzle, or the 404 body to return instead. */
  function puzzleToday(
    c: Context<AppEnv>,
  ): { date: string; puzzle: Puzzle } | Response {
    const date = today(deps.config);
    const puzzle = deps.companies.byDate(date);
    return puzzle
      ? { date, puzzle }
      : c.json(
          { error: "no_puzzle_today", message: date } satisfies ApiError,
          404,
        );
  }

  app.get("/today", (c) => {
    const found = puzzleToday(c);
    if (found instanceof Response) return found;
    return c.json(
      buildPlayState(
        deps,
        c.get("player")!.id,
        found.date,
        found.puzzle.number,
      ),
    );
  });

  app.post("/today/start", (c) => {
    const found = puzzleToday(c);
    if (found instanceof Response) return found;
    // Idempotent: a second call keeps the original `started_at`, so the clock is not reset.
    return c.json(
      startPlay(deps, c.get("player")!.id, found.date, found.puzzle),
    );
  });

  app.post("/today/guesses", async (c) => {
    const found = puzzleToday(c);
    if (found instanceof Response) return found;

    const body = GuessBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ error: "invalid_body" } satisfies ApiError, 400);
    }
    const guess = deps.companies.byId(body.data.companyId);
    if (!guess) {
      return c.json({ error: "unknown_company" } satisfies ApiError, 400);
    }

    const outcome = recordGuess(
      deps,
      c.get("player")!.id,
      found.date,
      found.puzzle,
      guess,
    );
    return outcome.ok
      ? c.json(outcome.state)
      : c.json({ error: outcome.error } satisfies ApiError, 409);
  });

  return app;
}
