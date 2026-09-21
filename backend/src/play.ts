/**
 * The play model: start, guess, and rebuild the state the SPA renders.
 *
 * Invariant 4 lives here. `buildPlayState` reads `puzzle_number`, `answer_json`, `guess_json` and
 * `cells_json` out of the play's own rows and never consults `CompanyIndex`, so renaming, deleting
 * or re-dating a company in `companies.json` cannot rewrite anyone's grid, share text or puzzle
 * number. Only the *scoring* of a new guess uses the live index.
 *
 * HTTP knows nothing about this file and this file knows nothing about HTTP: the routes resolve
 * today's puzzle and the guessed company, and turn the outcomes below into status codes.
 */
import {
  buildShareText,
  evaluateGuess,
  toCompanyLite,
  type CellFeedback,
  type Company,
  type CompanyLite,
  type GuessResult,
  type PlayState,
} from "@venturedle/shared/server";
import type { Deps } from "./config.js";
import type { Db } from "./db.js";

export interface Puzzle {
  company: Company;
  number: number;
}

interface PlayRow {
  puzzle_number: number;
  answer_json: string;
  started_at: string;
  solved_at: string | null;
  guess_count: number;
  elapsed_ms: number | null;
}

interface GuessRow {
  seq: number;
  guess_json: string;
  correct: number;
  cells_json: string;
  created_at: string;
}

/** The clock starts when the puzzle is shown (D9), so this is a no-op on a play that exists. */
function ensurePlay(
  db: Db,
  playerId: string,
  date: string,
  puzzle: Puzzle,
  now: Date,
): void {
  db.run(
    "INSERT INTO plays(player_id, date, puzzle_number, answer_json, started_at) " +
      "VALUES(?, ?, ?, ?, ?) ON CONFLICT(player_id, date) DO NOTHING",
    playerId,
    date,
    puzzle.number,
    JSON.stringify(toCompanyLite(puzzle.company)),
    now.toISOString(),
  );
}

/**
 * `fallbackNumber` is today's puzzle number, used only when the player has no play row yet — once
 * there is one, its snapshot wins.
 */
export function buildPlayState(
  deps: Deps,
  playerId: string,
  date: string,
  fallbackNumber: number,
): PlayState {
  const play = deps.db.get<PlayRow>(
    "SELECT puzzle_number, answer_json, started_at, solved_at, guess_count, elapsed_ms " +
      "FROM plays WHERE player_id = ? AND date = ?",
    playerId,
    date,
  );
  if (!play) {
    return { date, number: fallbackNumber, status: "not_started", guesses: [] };
  }

  const guesses: GuessResult[] = deps.db
    .all<GuessRow>(
      "SELECT seq, guess_json, correct, cells_json, created_at FROM guesses " +
        "WHERE player_id = ? AND date = ? ORDER BY seq",
      playerId,
      date,
    )
    .map((row) => ({
      seq: row.seq,
      guess: JSON.parse(row.guess_json) as CompanyLite,
      cells: JSON.parse(row.cells_json) as CellFeedback[],
      correct: row.correct === 1,
      at: row.created_at,
    }));

  const state: PlayState = {
    date,
    number: play.puzzle_number,
    status: play.solved_at ? "solved" : "playing",
    startedAt: play.started_at,
    guesses,
  };

  // The answer is serialised exactly once: after the win (invariant 1).
  if (play.solved_at) {
    const elapsedMs = play.elapsed_ms ?? 0;
    state.solvedAt = play.solved_at;
    state.elapsedMs = elapsedMs;
    state.answer = JSON.parse(play.answer_json) as CompanyLite;
    state.shareText = buildShareText({
      number: play.puzzle_number,
      date,
      guesses,
      elapsedMs,
      ...(deps.config.publicUrl ? { publicUrl: deps.config.publicUrl } : {}),
    });
  }
  return state;
}

export function startPlay(
  deps: Deps,
  playerId: string,
  date: string,
  puzzle: Puzzle,
): PlayState {
  ensurePlay(deps.db, playerId, date, puzzle, deps.config.now());
  return buildPlayState(deps, playerId, date, puzzle.number);
}

export type GuessOutcome =
  { ok: true; state: PlayState } | { ok: false; error: "already_guessed" };

/**
 * Scoring always uses `puzzle.company` — today's company from the live index — while `answer_json`
 * is only ever the snapshot used to render history. If an operator swaps today's company mid-day,
 * players who already started keep their snapshot for display but new guesses are scored against
 * the new company. That edge case is accepted, not handled.
 */
export function recordGuess(
  deps: Deps,
  playerId: string,
  date: string,
  puzzle: Puzzle,
  guess: Company,
): GuessOutcome {
  const now = deps.config.now();

  const written = deps.db.transaction<{ duplicate: boolean }>(() => {
    ensurePlay(deps.db, playerId, date, puzzle, now); // auto-start: the clock starts now
    const play = deps.db.get<PlayRow>(
      "SELECT started_at, solved_at, guess_count FROM plays WHERE player_id = ? AND date = ?",
      playerId,
      date,
    )!;

    // Guessing after a solve is a 200 no-op, not an error — see docs/02-data-contract.md.
    if (play.solved_at) return { duplicate: false };

    const seen = deps.db.get(
      "SELECT 1 FROM guesses WHERE player_id = ? AND date = ? AND company_id = ?",
      playerId,
      date,
      guess.id,
    );
    if (seen) return { duplicate: true };

    const { cells, correct } = evaluateGuess(guess, puzzle.company);
    const seq = play.guess_count + 1;
    deps.db.run(
      "INSERT INTO guesses(player_id, date, seq, company_id, guess_json, correct, cells_json, created_at) " +
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
      playerId,
      date,
      seq,
      guess.id,
      JSON.stringify(toCompanyLite(guess)),
      correct ? 1 : 0,
      JSON.stringify(cells),
      now.toISOString(),
    );

    if (correct) {
      deps.db.run(
        "UPDATE plays SET guess_count = ?, solved_at = ?, elapsed_ms = ? WHERE player_id = ? AND date = ?",
        seq,
        now.toISOString(),
        Math.max(0, now.getTime() - Date.parse(play.started_at)),
        playerId,
        date,
      );
    } else {
      deps.db.run(
        "UPDATE plays SET guess_count = ? WHERE player_id = ? AND date = ?",
        seq,
        playerId,
        date,
      );
    }
    return { duplicate: false };
  });

  return written.duplicate
    ? { ok: false, error: "already_guessed" }
    : { ok: true, state: buildPlayState(deps, playerId, date, puzzle.number) };
}
