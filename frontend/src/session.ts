/**
 * The session token, and the only mutable state outside React. It is a module-level store rather
 * than a `useState` in `App` because `api.ts` has to clear it from anywhere on a 401; `App`
 * subscribes with `useSyncExternalStore` and falls back to Onboarding when it goes away.
 *
 * Losing the token loses the player (anonymous mode) — see docs/01-game-rules.md.
 */
const KEY = "venturedle.token";

let token: string | null = localStorage.getItem(KEY);
const listeners = new Set<() => void>();

export function getToken(): string | null {
  return token;
}

/** `null` signs out. */
export function setToken(next: string | null): void {
  if (next === token) return;
  token = next;
  if (next) localStorage.setItem(KEY, next);
  else localStorage.removeItem(KEY);
  for (const listener of listeners) listener();
}

export function subscribeToken(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
