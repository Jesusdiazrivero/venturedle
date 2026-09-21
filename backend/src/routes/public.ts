/** The four endpoints that need no bearer token and reveal nothing about today's answer. */
import { Hono } from "hono";
import type {
  AppConfig,
  HealthResponse,
  PuzzleInfo,
} from "@venturedle/shared/server";
import type { AppEnv, Deps } from "../config.js";
import { nextUtcMidnight, today } from "../time.js";

export function publicRoutes({ config, companies }: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/health", (c) =>
    c.json({
      ok: true,
      companies: companies.count(),
      today: today(config),
      uptimeSec: Math.floor(process.uptime()),
    } satisfies HealthResponse),
  );

  app.get("/config", (c) =>
    c.json({
      authMode: config.auth.mode,
      ...(config.auth.mode === "google"
        ? {
            googleClientId: config.auth.clientId,
            ...(config.auth.allowedDomain
              ? { googleAllowedDomain: config.auth.allowedDomain }
              : {}),
          }
        : {}),
    } satisfies AppConfig),
  );

  // The guess pool is the whole schedule, past and future answers included (D10).
  app.get("/companies", (c) => {
    c.header("Cache-Control", "public, max-age=300");
    return c.json(companies.lite());
  });

  app.get("/puzzle/today", (c) => {
    const date = today(config);
    const puzzle = companies.byDate(date);
    return c.json({
      date,
      exists: puzzle !== undefined,
      ...(puzzle ? { number: puzzle.number } : {}),
      // Always from the real clock: DEV_TODAY pins the schedule, not the countdown.
      nextPuzzleAt: nextUtcMidnight(config.now()),
    } satisfies PuzzleInfo);
  });

  return app;
}
