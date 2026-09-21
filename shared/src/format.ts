/**
 * The one way an elapsed time is written, shared by the share text (server) and the running clock
 * and the countdown (client). It lives outside `scoring.ts` so the client entry point can export it
 * without re-exporting anything that knows what the answer is.
 */

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
