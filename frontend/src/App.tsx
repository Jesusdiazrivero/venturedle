/**
 * The shell: load `/api/config`, decide between Onboarding and the game, and route on the hash.
 * Nothing here knows how to play — it only decides who is asking and which view is showing.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { AppConfig, Player, PuzzleInfo } from "@venturedle/shared";
import * as api from "./api.js";
import { Header } from "./Header.js";
import { Leaderboard } from "./Leaderboard.js";
import { Onboarding } from "./Onboarding.js";
import { Play } from "./Play.js";
import { useCountdown, useHashRoute } from "./hooks.js";
import { getToken, setToken, subscribeToken } from "./session.js";

/** How often to re-ask for today's puzzle once the countdown has run out. */
const ROLLOVER_POLL_MS = 5_000;

function Game({ config }: { config: AppConfig }) {
  const route = useHashRoute();
  const [player, setPlayer] = useState<Player | null>(null);
  const [puzzle, setPuzzle] = useState<PuzzleInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Midnight UTC turns the puzzle over under an open tab. Our clock can be ahead of the server's,
  // so asking once at zero can hand back the same day — keep asking until the answer moves on,
  // which it announces by a `nextPuzzleAt` the countdown is no longer at zero for.
  const nextPuzzleAt = puzzle?.nextPuzzleAt;
  const rolledOver = useCountdown(nextPuzzleAt) === 0;

  useEffect(() => {
    if (!nextPuzzleAt || !rolledOver) return;
    const ask = () => void api.getPuzzle().then(setPuzzle, () => undefined);
    ask();
    const timer = setInterval(ask, ROLLOVER_POLL_MS);
    return () => clearInterval(timer);
  }, [nextPuzzleAt, rolledOver]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getMe(), api.getPuzzle()])
      .then(([me, today]) => {
        if (cancelled) return;
        setPlayer(me);
        setPuzzle(today);
      })
      // A 401 has already cleared the token, so this only reports the failures worth reporting.
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function signOut() {
    if (
      config.authMode === "anonymous" &&
      !window.confirm(
        "Signing out of an anonymous player is permanent — your history cannot be recovered. Continue?",
      )
    ) {
      return;
    }
    await api.signOut().catch(() => undefined);
    setToken(null);
  }

  if (error) return <p className="error">{error}</p>;
  if (!player || !puzzle) return <p className="hint">Loading…</p>;

  return (
    <>
      <Header
        player={player}
        puzzle={puzzle}
        route={route}
        onRename={async (nickname) =>
          setPlayer(await api.setNickname(nickname))
        }
        onSignOut={() => void signOut()}
      />
      {route === "/leaderboard" ? (
        <Leaderboard />
      ) : (
        // Keyed by date: a rollover replaces the board rather than reusing yesterday's grid.
        <Play key={puzzle.date} puzzle={puzzle} />
      )}
    </>
  );
}

export function App() {
  const token = useSyncExternalStore(subscribeToken, getToken);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getConfig().then(setConfig, (err: Error) => setError(err.message));
  }, []);

  if (error) return <p className="error">Cannot reach the server: {error}</p>;
  if (!config) return <p className="hint">Loading…</p>;
  if (!token) return <Onboarding config={config} />;
  // Remount on a new token so no view keeps the previous player's data.
  return <Game key={token} config={config} />;
}
