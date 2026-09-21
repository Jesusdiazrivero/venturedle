/**
 * Two scopes × two orderings, and the caller's own row when they are outside the top 50.
 *
 * The ranking is done in SQL with `RANK()` rather than by counting rows in JS so that the top-50
 * list and the "me" lookup agree about ties. Leaderboards are cheap at this scale; nothing is
 * cached.
 */
import { Hono } from "hono";
import type {
  AuthProvider,
  Leaderboard,
  LeaderboardRow,
} from "@venturedle/shared/server";
import type { AppEnv, Deps } from "../config.js";
import type { Param } from "../db.js";
import { today } from "../time.js";

const TOP = 50;

type Scope = Leaderboard["scope"];
type By = Leaderboard["by"];

interface Row {
  rank: number;
  guesses: number;
  elapsed_ms: number | null;
  /** all-time only; NULL for today */
  days: number | null;
  id: string;
  nickname: string;
  provider: AuthProvider;
}

const ORDER: Record<Scope, Record<By, string>> = {
  today: {
    guesses: "guess_count ASC, elapsed_ms ASC, solved_at ASC",
    time: "elapsed_ms ASC, guess_count ASC, solved_at ASC",
  },
  alltime: {
    guesses: "avg_guesses ASC, days DESC",
    time: "avg_ms ASC, days DESC",
  },
};

/** Everything up to the outer SELECT; callers append `WHERE`/`ORDER BY`/`LIMIT`. */
function ranked(scope: Scope, by: By): string {
  const cte =
    scope === "today"
      ? `WITH ranked AS (
           SELECT player_id, guess_count AS guesses, elapsed_ms, NULL AS days,
                  RANK() OVER (ORDER BY ${ORDER.today[by]}) AS rank
           FROM plays WHERE date = ? AND solved_at IS NOT NULL
         )`
      : `WITH agg AS (
           SELECT player_id, COUNT(*) AS days,
                  AVG(guess_count) AS avg_guesses, AVG(elapsed_ms) AS avg_ms
           FROM plays WHERE solved_at IS NOT NULL GROUP BY player_id
         ), ranked AS (
           SELECT player_id, avg_guesses AS guesses, avg_ms AS elapsed_ms, days,
                  RANK() OVER (ORDER BY ${ORDER.alltime[by]}) AS rank
           FROM agg
         )`;
  return `${cte}
    SELECT r.rank, r.guesses, r.elapsed_ms, r.days, p.id, p.nickname, p.provider
    FROM ranked r JOIN players p ON p.id = r.player_id`;
}

function toRow(row: Row, meId: string | undefined): LeaderboardRow {
  return {
    rank: row.rank,
    player: { id: row.id, nickname: row.nickname, provider: row.provider },
    isMe: row.id === meId,
    // All-time averages: two decimals for guesses, whole milliseconds for time.
    guesses: Math.round(row.guesses * 100) / 100,
    elapsedMs: Math.round(row.elapsed_ms ?? 0),
    ...(row.days === null ? {} : { daysSolved: row.days }),
  };
}

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function leaderboardRoutes({ config, db }: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/leaderboard", (c) => {
    const scope = oneOf(
      c.req.query("scope"),
      ["today", "alltime"] as const,
      "today",
    );
    const by = oneOf(
      c.req.query("by"),
      ["guesses", "time"] as const,
      "guesses",
    );
    const date = today(config);
    const scopeParams: Param[] = scope === "today" ? [date] : [];
    const meId = c.get("player")?.id;

    const rows = db
      .all<Row>(
        `${ranked(scope, by)} ORDER BY r.rank, p.id LIMIT ${TOP}`,
        ...scopeParams,
      )
      .map((row) => toRow(row, meId));

    const board: Leaderboard = {
      scope,
      by,
      ...(scope === "today" ? { date } : {}),
      rows,
    };

    if (meId && !rows.some((row) => row.isMe)) {
      const mine = db.get<Row>(
        `${ranked(scope, by)} WHERE r.player_id = ?`,
        ...scopeParams,
        meId,
      );
      if (mine) board.me = toRow(mine, meId);
    }

    return c.json(board);
  });

  return app;
}
