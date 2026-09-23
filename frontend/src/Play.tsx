/**
 * The puzzle. The server's `PlayState` is the single source of truth: every mutation answers with a
 * whole one and we replace, never merge — which is what makes reload-and-resume trivial and keeps
 * the client from ever computing feedback or win state.
 */
import { useEffect, useRef, useState } from "react";
import { formatElapsed } from "@venturedle/shared";
import type { CompanyLite, PlayState, PuzzleInfo } from "@venturedle/shared";
import * as api from "./api.js";
import { ApiError } from "./api.js";
import { CompanyPicker } from "./CompanyPicker.js";
import { GuessGrid } from "./GuessGrid.js";
import { useCountdown, useElapsed } from "./hooks.js";

function message(error: unknown): string {
  if (error instanceof ApiError && error.code === "already_guessed") {
    return "You have already guessed that one.";
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

function WinPanel({ state, nextIn }: { state: PlayState; nextIn: number }) {
  const [copyNote, setCopyNote] = useState<string | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(state.shareText ?? "");
      setCopyNote("Copied!");
    } catch {
      setCopyNote("Copy failed — select the text above.");
    }
  }

  return (
    <section className="win">
      <h2>
        <img src={state.answer?.logoUrl} alt="" className="logo" />
        {state.answer?.name}
      </h2>
      <p>
        Solved in {state.guesses.length}{" "}
        {state.guesses.length === 1 ? "guess" : "guesses"} ·{" "}
        {formatElapsed(state.elapsedMs ?? 0)}
      </p>
      <pre className="share">{state.shareText}</pre>
      <div className="win-actions">
        <button type="button" onClick={() => void copy()}>
          Copy
        </button>
        <a href="#/leaderboard">See leaderboard</a>
      </div>
      {copyNote ? <p className="hint">{copyNote}</p> : null}
      <p className="hint">Next puzzle in {formatElapsed(nextIn)}</p>
    </section>
  );
}

export function Play({ puzzle }: { puzzle: PuzzleInfo }) {
  const [companies, setCompanies] = useState<readonly CompanyLite[]>([]);
  const [play, setPlay] = useState<PlayState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The clock has to be fair from the moment the board is visible, and started only once (D9).
  const started = useRef<string | null>(null);

  const nextIn = useCountdown(puzzle.nextPuzzleAt);
  const elapsed = useElapsed(play?.startedAt, play?.elapsedMs);

  useEffect(() => {
    if (!puzzle.exists) return;
    let cancelled = false;
    void (async () => {
      try {
        const [pool, state] = await Promise.all([
          api.getCompanies(),
          api.getPlay(),
        ]);
        if (cancelled) return;
        setCompanies(pool);
        if (state.status === "not_started" && started.current !== state.date) {
          started.current = state.date;
          const startedState = await api.startPlay();
          if (!cancelled) setPlay(startedState);
        } else {
          setPlay(state);
        }
      } catch (err) {
        if (!cancelled) setError(message(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [puzzle.exists, puzzle.date]);

  async function guess(company: CompanyLite) {
    setError(null);
    try {
      setPlay(await api.submitGuess(company.id));
    } catch (err) {
      setError(message(err));
    }
  }

  if (!puzzle.exists) {
    return (
      <main className="play">
        <section className="empty">
          <h2>No puzzle today</h2>
          <p>Nothing is scheduled for {puzzle.date} UTC.</p>
          <p className="hint">Next UTC day in {formatElapsed(nextIn)}</p>
        </section>
      </main>
    );
  }

  const solved = play?.status === "solved";

  return (
    <main className="play">
      <CompanyPicker
        companies={companies}
        guessedIds={play?.guesses.map((g) => g.guess.id) ?? []}
        disabled={!play || solved}
        onPick={(company) => void guess(company)}
      />
      {error ? <p className="error">{error}</p> : null}
      {play ? (
        <>
          <GuessGrid guesses={play.guesses} />
          <p className="status">
            ⏱ {formatElapsed(elapsed)} · {play.guesses.length}{" "}
            {play.guesses.length === 1 ? "guess" : "guesses"}
          </p>
          {solved ? <WinPanel state={play} nextIn={nextIn} /> : null}
        </>
      ) : (
        <p className="hint">Loading…</p>
      )}
    </main>
  );
}
