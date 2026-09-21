/**
 * The environment surface (the whole table is in `docs/04-backend.md`) plus the two types every
 * route needs: the Hono env and the bag of things `createApp` built. `loadConfig` is only ever
 * called by `server.ts` — nothing below the composition root reads `process.env`.
 */
import path from "node:path";
import { isCalendarDate, type Player } from "@venturedle/shared/server";
import type { CompanyIndex } from "./companies.js";
import type { Db } from "./db.js";
import { createGoogleVerifier, type GoogleVerifier } from "./auth.js";

export type AuthConfig =
  | { mode: "anonymous" }
  | {
      mode: "google";
      clientId: string;
      /** when set, the ID token's `hd` claim must match */
      allowedDomain?: string;
      verify: GoogleVerifier;
    };

export interface Config {
  port: number;
  /** always `$DATA_DIR/venturedle.db`, or `:memory:` in tests */
  dbFile: string;
  companiesFile: string;
  /** absolute; served at `/` when it exists */
  staticDir: string;
  /** appended to share text */
  publicUrl?: string;
  auth: AuthConfig;
  /** dev/test only: pins the puzzle date, never the clock */
  devToday?: string;
  now: () => Date;
}

/** What `createApp` builds once and every router borrows. */
export interface Deps {
  config: Config;
  db: Db;
  companies: CompanyIndex;
}

/**
 * `player` is set by the `authenticate` middleware on every `/api/*` request that carries a valid
 * bearer token, and left unset otherwise — `requireAuth` is what turns "unset" into a 401.
 */
export interface AppEnv {
  Variables: { player?: Player };
}

function fail(message: string): never {
  throw new Error(`invalid configuration: ${message}`);
}

function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const mode = env.AUTH_MODE?.trim() || "anonymous";
  if (mode === "anonymous") return { mode };
  if (mode !== "google") {
    fail(`AUTH_MODE must be "anonymous" or "google", got "${mode}"`);
  }
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  if (!clientId) fail("AUTH_MODE=google needs GOOGLE_CLIENT_ID");
  const allowedDomain = env.GOOGLE_ALLOWED_DOMAIN?.trim();
  return {
    mode: "google",
    clientId,
    ...(allowedDomain ? { allowedDomain } : {}),
    verify: createGoogleVerifier(clientId),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  // npm sets INIT_CWD to where `npm run` was invoked; in Docker every path is absolute anyway.
  const root = env.INIT_CWD ?? process.cwd();
  const resolve = (p: string) => path.resolve(root, p);

  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0) fail(`PORT "${env.PORT}"`);

  const dataDir = resolve(env.DATA_DIR?.trim() || "data");

  const devToday = env.DEV_TODAY?.trim();
  if (devToday) {
    if (env.NODE_ENV === "production") {
      fail("DEV_TODAY must not be set with NODE_ENV=production");
    }
    if (!isCalendarDate(devToday))
      fail(`DEV_TODAY "${devToday}" is not YYYY-MM-DD`);
  }

  const publicUrl = env.PUBLIC_URL?.trim();

  return {
    port,
    dbFile: path.join(dataDir, "venturedle.db"),
    companiesFile: resolve(
      env.COMPANIES_FILE?.trim() || path.join(dataDir, "companies.json"),
    ),
    staticDir: resolve(env.STATIC_DIR?.trim() || "frontend/dist"),
    ...(publicUrl ? { publicUrl } : {}),
    auth: loadAuthConfig(env),
    ...(devToday ? { devToday } : {}),
    now: () => new Date(),
  };
}
