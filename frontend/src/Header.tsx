/**
 * Title, today's puzzle, the nav link and the profile menu. The menu is a `<details>` so the
 * open/close behaviour, keyboard handling and escape are the browser's, not ours.
 */
import { useState } from "react";
import type { FormEvent } from "react";
import type { Player, PuzzleInfo } from "@venturedle/shared";

export function Header({
  player,
  puzzle,
  route,
  onRename,
  onSignOut,
}: {
  player: Player;
  puzzle: PuzzleInfo | null;
  route: string;
  onRename: (nickname: string) => Promise<void>;
  onSignOut: () => void;
}) {
  const [nickname, setNickname] = useState(player.nickname);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onRename(nickname);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <header className="header">
      <a className="brand" href="#/">
        VENTUREDLE
      </a>
      {puzzle?.exists ? (
        <span className="puzzle-id">
          #{puzzle.number} · {puzzle.date} UTC
        </span>
      ) : null}
      <nav className="header-actions">
        <a href={route === "/leaderboard" ? "#/" : "#/leaderboard"}>
          {route === "/leaderboard" ? "Play" : "Board"}
        </a>
        <details className="menu">
          <summary>{player.nickname} ▾</summary>
          <div className="menu-panel">
            <form onSubmit={save}>
              <label htmlFor="nickname">Nickname</label>
              <input
                id="nickname"
                value={nickname}
                maxLength={24}
                onChange={(e) => setNickname(e.target.value)}
              />
              <button
                type="submit"
                disabled={saving || nickname === player.nickname}
              >
                Save
              </button>
            </form>
            {error ? <p className="error">{error}</p> : null}
            <button type="button" className="link" onClick={onSignOut}>
              Sign out
            </button>
          </div>
        </details>
      </nav>
    </header>
  );
}
