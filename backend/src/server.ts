/**
 * The composition root: it reads the environment, opens the database, loads the schedule, wires the
 * middleware and the routers, and listens. Everything below it is handed what it needs.
 */
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { ApiError } from "@venturedle/shared/server";
import { authenticate } from "./auth.js";
import { CompanyIndex } from "./companies.js";
import { loadConfig, type AppEnv, type Config, type Deps } from "./config.js";
import { openDb } from "./db.js";
import { identityRoutes } from "./routes/identity.js";
import { leaderboardRoutes } from "./routes/leaderboard.js";
import { publicRoutes } from "./routes/public.js";
import { resultsRoutes } from "./routes/results.js";
import { mountStatic } from "./static.js";
import { today } from "./time.js";

/** Throws if the database cannot be opened or `companies.json` is missing or invalid. */
export function createApp(config: Config): { app: Hono<AppEnv>; deps: Deps } {
  const deps: Deps = {
    config,
    db: openDb(config.dbFile),
    companies: CompanyIndex.load(config.companiesFile),
  };

  const app = new Hono<AppEnv>();

  app.use(
    "*",
    secureHeaders({
      // The default `same-origin` silently breaks the Google Identity Services popup.
      crossOriginOpenerPolicy: "same-origin-allow-popups",
      xFrameOptions: "DENY",
    }),
  );

  // Middleware to ensure that we always have the latest companies.json loaded.
  app.use("/api/*", async (_c, next) => {
    deps.companies.maybeReload(config.now().getTime());
    await next();
  });
  app.use("/api/*", authenticate(deps.db, config.now));

  app.route("/api", publicRoutes(deps));
  app.route("/api", identityRoutes(deps));
  app.route("/api", leaderboardRoutes(deps));
  app.route("/api/results", resultsRoutes(deps));
  app.all("/api/*", (c) =>
    c.json({ error: "not_found" } satisfies ApiError, 404),
  );

  mountStatic(app, config.staticDir);

  app.onError((err, c) => {
    console.error(`error ${c.req.method} ${c.req.path}: ${err.stack ?? err}`);
    return c.json({ error: "internal" } satisfies ApiError, 500);
  });

  return { app, deps };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // A bad env var, a missing companies.json and an unwritable DATA_DIR are all the same kind of
  // event to an operator — one line saying what is wrong, then exit 1. No stack traces at boot.
  try {
    const config = loadConfig(process.env);
    const { app, deps } = createApp(config);
    serve({ fetch: app.fetch, port: config.port });
    console.log(
      `venturedle listening on :${config.port} — auth=${config.auth.mode} ` +
        `companies=${deps.companies.count()} today=${today(config)}` +
        (config.devToday ? " (DEV_TODAY)" : ""),
    );
  } catch (err) {
    console.error(`boot failed: ${(err as Error).message}`);
    process.exit(1);
  }
}
