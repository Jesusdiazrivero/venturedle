/**
 * The whole of the game's logic, as pure functions. Ported from v1's
 * `backend/src/lib/evaluateGuess.ts` and `share.ts`, with the v2 changes: `correct` is id-equality
 * rather than "all cells green", the bucket edges are disjoint, and the share text carries the
 * puzzle number, the date, the guess count and the elapsed time.
 *
 * Every rule here is normative in `docs/01-game-rules.md`. Changing one means changing that doc,
 * this file and `test/scoring.test.ts` together.
 */
import type { CellFeedback, Direction, GuessResult } from "./api.js";
import type { Company } from "./company.js";
import {
  FUNDING_BUCKETS,
  FUNDING_STAGES,
  HEADCOUNT_BUCKETS,
  bucketOf,
} from "./enums.js";

function setEquals<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  for (const x of b) if (!s.has(x)) return false;
  return true;
}

function intersects<T>(a: readonly T[], b: readonly T[]): boolean {
  const s = new Set(a);
  for (const x of b) if (s.has(x)) return true;
  return false;
}

/** "higher" means the answer is above the guess, i.e. the player should guess higher. */
function directionFrom(guessValue: number, answerValue: number): Direction {
  return guessValue < answerValue ? "higher" : "lower";
}

function setCell(
  column: "sectors" | "businessModel",
  guessValues: readonly string[],
  answerValues: readonly string[],
): CellFeedback {
  return {
    column,
    color: setEquals(guessValues, answerValues)
      ? "green"
      : intersects(guessValues, answerValues)
        ? "yellow"
        : "grey",
    displayValue: guessValues.join(", "),
  };
}

export function evaluateGuess(
  guess: Company,
  answer: Company,
): { cells: CellFeedback[]; correct: boolean } {
  const cells: CellFeedback[] = [];

  cells.push(setCell("sectors", guess.sectors, answer.sectors));

  // Country, falling back to the region for the yellow.
  cells.push({
    column: "hqCountry",
    color:
      guess.hqCountry === answer.hqCountry
        ? "green"
        : guess.region === answer.region
          ? "yellow"
          : "grey",
    displayValue: guess.hqCountry,
  });

  // Founded year: green or grey, never yellow.
  {
    const equal = guess.foundedYear === answer.foundedYear;
    cells.push({
      column: "foundedYear",
      color: equal ? "green" : "grey",
      ...(equal
        ? {}
        : { direction: directionFrom(guess.foundedYear, answer.foundedYear) }),
      displayValue: String(guess.foundedYear),
    });
  }

  // Funding stage: ordinal distance in FUNDING_STAGES. Yellow (±1) also carries a direction.
  {
    const gi = FUNDING_STAGES.indexOf(guess.fundingStage);
    const ai = FUNDING_STAGES.indexOf(answer.fundingStage);
    const distance = Math.abs(ai - gi);
    const color = distance === 0 ? "green" : distance === 1 ? "yellow" : "grey";
    cells.push({
      column: "fundingStage",
      color,
      ...(color === "green" ? {} : { direction: directionFrom(gi, ai) }),
      displayValue: guess.fundingStage,
    });
  }

  // Total funding and headcount: compared by bucket, and only the bucket label is ever shown —
  // the exact numbers stay on the server.
  {
    const gb = bucketOf(guess.totalFundingUsd, FUNDING_BUCKETS);
    const ab = bucketOf(answer.totalFundingUsd, FUNDING_BUCKETS);
    const equal = gb.index === ab.index;
    cells.push({
      column: "totalFundingUsd",
      color: equal ? "green" : "grey",
      ...(equal ? {} : { direction: directionFrom(gb.index, ab.index) }),
      displayValue: gb.label,
    });
  }

  {
    const gb = bucketOf(guess.headcount, HEADCOUNT_BUCKETS);
    const ab = bucketOf(answer.headcount, HEADCOUNT_BUCKETS);
    const equal = gb.index === ab.index;
    cells.push({
      column: "headcount",
      color: equal ? "green" : "grey",
      ...(equal ? {} : { direction: directionFrom(gb.index, ab.index) }),
      displayValue: gb.label,
    });
  }

  cells.push(
    setCell("businessModel", guess.businessModel, answer.businessModel),
  );

  // Not `cells.every(green)`: two distinct companies can share a seven-tuple, and an all-green
  // near-miss must still read as a miss. See docs/01-game-rules.md.
  return { cells, correct: guess.id === answer.id };
}

const EMOJI: Record<CellFeedback["color"], string> = {
  green: "🟩",
  yellow: "🟨",
  grey: "⬜",
};

/** `mm:ss`, or `h:mm:ss` once past an hour. */
export function formatElapsed(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

export function buildShareText(args: {
  number: number;
  date: string;
  guesses: readonly GuessResult[];
  elapsedMs: number;
  publicUrl?: string;
}): string {
  const count = args.guesses.length;
  const header = [
    `Venturedle #${args.number}`,
    args.date,
    `${count} ${count === 1 ? "guess" : "guesses"}`,
    formatElapsed(args.elapsedMs),
  ].join(" · ");
  const rows = args.guesses.map((g) =>
    g.cells.map((c) => EMOJI[c.color]).join(""),
  );
  const lines = [header, ...rows];
  if (args.publicUrl) lines.push(args.publicUrl);
  return lines.join("\n");
}
