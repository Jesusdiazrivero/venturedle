/**
 * Two scopes × two metrics, straight from the server. Unsolved plays never appear, so an empty
 * table means nobody has finished — not that the query failed.
 */
import { useEffect, useState } from "react";
import { formatElapsed } from "@venturedle/shared";
import type { Leaderboard as Board, LeaderboardRow } from "@venturedle/shared";
import * as api from "./api.js";

function Row({ row, scope }: { row: LeaderboardRow; scope: Board["scope"] }) {
  return (
    <tr className={row.isMe ? "me" : undefined}>
      <td>{row.rank}</td>
      <td>{row.player.nickname}</td>
      <td>{row.guesses}</td>
      <td>{formatElapsed(row.elapsedMs)}</td>
      {scope === "alltime" ? <td>{row.daysSolved ?? 0}</td> : null}
    </tr>
  );
}

export function Leaderboard() {
  const [scope, setScope] = useState<Board["scope"]>("today");
  const [by, setBy] = useState<Board["by"]>("guesses");
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getLeaderboard(scope, by)
      .then((next) => {
        if (!cancelled) setBoard(next);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, by]);

  return (
    <main className="leaderboard">
      <div className="toggles">
        <div className="toggle" role="group" aria-label="Scope">
          {(["today", "alltime"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={scope === value}
              onClick={() => setScope(value)}
            >
              {value === "today" ? "Today" : "All-time"}
            </button>
          ))}
        </div>
        <div className="toggle" role="group" aria-label="Metric">
          {(["guesses", "time"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={by === value}
              onClick={() => setBy(value)}
            >
              {value === "guesses" ? "Guesses" : "Time"}
            </button>
          ))}
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {board && board.rows.length === 0 ? (
        <p className="empty">
          {board.scope === "today"
            ? "Nobody has solved today's puzzle yet — be the first."
            : "No solved puzzles yet — be the first."}
        </p>
      ) : null}
      {board && board.rows.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Player</th>
              <th>{board.scope === "alltime" ? "Avg guesses" : "Guesses"}</th>
              <th>{board.scope === "alltime" ? "Avg time" : "Time"}</th>
              {board.scope === "alltime" ? <th>Days</th> : null}
            </tr>
          </thead>
          <tbody>
            {board.rows.map((row) => (
              <Row key={row.player.id} row={row} scope={board.scope} />
            ))}
            {board.me ? <Row row={board.me} scope={board.scope} /> : null}
          </tbody>
        </table>
      ) : null}
    </main>
  );
}
