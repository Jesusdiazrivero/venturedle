/**
 * The three hooks the views share. One file rather than three one-function modules (CLAUDE.md,
 * simplicity rule 1).
 */
import { useEffect, useState, useSyncExternalStore } from "react";

function currentRoute(): string {
  const hash = window.location.hash.replace(/^#/, "");
  return hash.startsWith("/") ? hash : "/";
}

function subscribeHash(listener: () => void): () => void {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

/** `"/"` or `"/leaderboard"` — the whole router. */
export function useHashRoute(): string {
  return useSyncExternalStore(subscribeHash, currentRoute);
}

function msUntil(target: number): number {
  return Number.isNaN(target) ? 0 : Math.max(0, target - Date.now());
}

/** Milliseconds left until `targetIso`, ticking every second. */
export function useCountdown(targetIso: string | undefined): number {
  const target = targetIso ? Date.parse(targetIso) : Number.NaN;
  const [remaining, setRemaining] = useState(() => msUntil(target));

  useEffect(() => {
    setRemaining(msUntil(target));
    if (Number.isNaN(target)) return;
    const timer = setInterval(() => setRemaining(msUntil(target)), 1000);
    return () => clearInterval(timer);
  }, [target]);

  return remaining;
}

/**
 * Milliseconds since `startedAt`, ticking every second. `frozenMs` is the server's final time on a
 * solved play: once it is set the clock stops and the server's number is what is shown, so a
 * reload never disagrees with the share text.
 */
export function useElapsed(
  startedAt: string | undefined,
  frozenMs: number | undefined,
): number {
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  const running = frozenMs === undefined;
  const [elapsed, setElapsed] = useState(() => Math.max(0, Date.now() - start));

  useEffect(() => {
    if (!running || Number.isNaN(start)) return;
    setElapsed(Math.max(0, Date.now() - start));
    const timer = setInterval(
      () => setElapsed(Math.max(0, Date.now() - start)),
      1000,
    );
    return () => clearInterval(timer);
  }, [start, running]);

  if (frozenMs !== undefined) return frozenMs;
  return Number.isNaN(start) ? 0 : elapsed;
}
