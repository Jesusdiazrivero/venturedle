/**
 * The board. Column order, labels and count all come from `COLUMN_DEFS` in `@venturedle/shared`, so
 * adding a column is a change in one place; the colours, arrows and text come from the server's
 * `CellFeedback` — the client never scores anything.
 */
import { COLUMN_DEFS } from "@venturedle/shared";
import type { CellFeedback, GuessResult } from "@venturedle/shared";

const VERDICT: Record<CellFeedback["color"], string> = {
  green: "match",
  yellow: "partial match",
  grey: "no match",
};

const ARROW: Record<NonNullable<CellFeedback["direction"]>, string> = {
  higher: "↑",
  lower: "↓",
};

let flagsRender: boolean | undefined;

/**
 * Windows has no flag glyphs and renders a regional-indicator pair as two letters, i.e. twice as
 * wide as one indicator. Measured once and cached; when the measurement is unavailable we show the
 * ISO-2 code, which is never wrong, only plainer.
 */
function platformRendersFlags(): boolean {
  if (flagsRender !== undefined) return flagsRender;
  try {
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return (flagsRender = false);
    context.font = "16px sans-serif";
    const pair = context.measureText("\u{1F1FA}\u{1F1F8}").width;
    const single = context.measureText("\u{1F1FA}").width;
    flagsRender = single > 0 && pair < single * 2;
  } catch {
    flagsRender = false;
  }
  return flagsRender;
}

function flagOf(isoCode: string): string {
  if (!/^[A-Za-z]{2}$/.test(isoCode) || !platformRendersFlags()) return isoCode;
  return String.fromCodePoint(
    ...[...isoCode.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

function Cell({
  cell,
  label,
  column,
}: {
  cell: CellFeedback;
  label: string;
  column: number;
}) {
  const text =
    cell.column === "hqCountry" ? flagOf(cell.displayValue) : cell.displayValue;
  const hint = cell.direction ? `, answer is ${cell.direction}` : "";
  return (
    <div
      className={`cell ${cell.color}`}
      role="cell"
      aria-label={`${label}: ${cell.displayValue} — ${VERDICT[cell.color]}${hint}`}
      style={{ animationDelay: `${column * 80}ms` }}
    >
      <span className="cell-value">{text}</span>
      {cell.direction ? (
        <span className="cell-arrow" aria-hidden="true">
          {ARROW[cell.direction]}
        </span>
      ) : null}
    </div>
  );
}

export function GuessGrid({ guesses }: { guesses: readonly GuessResult[] }) {
  if (guesses.length === 0) return null;
  // Newest on top, like v1: the row you just played is the one you are reading.
  const rows = [...guesses].reverse();

  return (
    <div className="grid-scroll">
      <div className="grid" role="table" aria-label="Your guesses">
        <div className="grid-head" role="row">
          <div role="columnheader">Company</div>
          {COLUMN_DEFS.map((column) => (
            <div key={column.key} role="columnheader">
              {column.label}
            </div>
          ))}
        </div>
        {rows.map((guess) => (
          <div className="grid-row" role="row" key={guess.seq}>
            <div className="guess-name" role="rowheader">
              <img
                src={guess.guess.logoUrl}
                alt=""
                className="logo"
                onError={(e) => {
                  e.currentTarget.style.visibility = "hidden";
                }}
              />
              <span>{guess.guess.name}</span>
            </div>
            {guess.cells.map((cell, index) => (
              <Cell
                key={cell.column}
                cell={cell}
                column={index}
                label={COLUMN_DEFS[index]?.label ?? cell.column}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
