/**
 * "Today" is the server's UTC date — invariant 6. Every date in the game comes from here so that
 * there is exactly one place where the day flips.
 */
import type { Config } from "./config.js";

export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** ISO timestamp of the next 00:00 UTC after `at`. The SPA counts down to it. */
export function nextUtcMidnight(at: Date): string {
  const next = new Date(at);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

/** `DEV_TODAY` pins the date only; the clock itself stays real so elapsed times are honest. */
export function today(config: Config): string {
  return config.devToday ?? utcDate(config.now());
}
