/**
 * Players, sessions and the bearer middleware. Both auth modes (D6) end in the same place: a
 * random token whose sha256 is the primary key of a `sessions` row. The raw token is returned to
 * the client once and never stored or logged (invariant 7).
 */
import { createHash, randomBytes } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import type { MiddlewareHandler } from "hono";
import type { ApiError, AuthProvider, Player } from "@venturedle/shared/server";
import type { AppEnv } from "./config.js";
import type { Db } from "./db.js";

/** How stale `last_seen_at` is allowed to get before we spend a write on it. */
const LAST_SEEN_THROTTLE_MS = 60_000;

const NICKNAME_MIN = 2;
const NICKNAME_MAX = 24;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

interface PlayerRow {
  id: string;
  nickname: string;
  provider: AuthProvider;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Drop control characters, trim, then length-check. Returns null when unusable. */
export function normaliseNickname(raw: string): string | null {
  const cleaned = raw.replace(CONTROL_CHARS, "").trim();
  return cleaned.length >= NICKNAME_MIN && cleaned.length <= NICKNAME_MAX
    ? cleaned
    : null;
}

export function getPlayer(db: Db, id: string): Player | undefined {
  return db.get<PlayerRow>(
    "SELECT id, nickname, provider FROM players WHERE id = ?",
    id,
  );
}

function upsertPlayer(db: Db, player: Player, now: Date): Player {
  const iso = now.toISOString();
  // Only `last_seen_at` is refreshed on conflict: a later PATCH /api/me must survive the next
  // sign-in, so Google's `name` is the nickname on first sight only.
  db.run(
    "INSERT INTO players(id, nickname, provider, created_at, last_seen_at) VALUES(?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at",
    player.id,
    player.nickname,
    player.provider,
    iso,
    iso,
  );
  return getPlayer(db, player.id)!;
}

export function createAnonymousPlayer(
  db: Db,
  nickname: string,
  now: Date,
): Player {
  return upsertPlayer(
    db,
    {
      id: `anon:${randomBytes(16).toString("base64url")}`,
      nickname,
      provider: "anonymous",
    },
    now,
  );
}

/** Signing in again, on any device, resolves to the same player. */
export function upsertGooglePlayer(
  db: Db,
  identity: GoogleIdentity,
  now: Date,
): Player {
  const fallback = identity.name ?? identity.email?.split("@")[0] ?? "Player";
  return upsertPlayer(
    db,
    {
      id: `google:${identity.sub}`,
      nickname: normaliseNickname(fallback) ?? "Player",
      provider: "google",
    },
    now,
  );
}

export function setNickname(
  db: Db,
  playerId: string,
  nickname: string,
): Player {
  db.run("UPDATE players SET nickname = ? WHERE id = ?", nickname, playerId);
  return getPlayer(db, playerId)!;
}

/** Returns the raw token; only its hash reaches the database. */
export function createSession(db: Db, playerId: string, now: Date): string {
  const token = randomBytes(32).toString("base64url");
  const iso = now.toISOString();
  db.run(
    "INSERT INTO sessions(token_hash, player_id, created_at, last_seen_at) VALUES(?, ?, ?, ?)",
    hashToken(token),
    playerId,
    iso,
    iso,
  );
  return token;
}

export function revokeSession(db: Db, token: string): void {
  db.run("DELETE FROM sessions WHERE token_hash = ?", hashToken(token));
}

export function bearerToken(header: string | undefined): string | undefined {
  return header?.match(/^Bearer\s+(\S+)$/i)?.[1];
}

/** One conditional UPDATE each: no read, and no write at all on a busy player's every request. */
function touch(db: Db, tokenHash: string, playerId: string, now: Date): void {
  const iso = now.toISOString();
  const stale = new Date(now.getTime() - LAST_SEEN_THROTTLE_MS).toISOString();
  db.run(
    "UPDATE sessions SET last_seen_at = ? WHERE token_hash = ? AND last_seen_at < ?",
    iso,
    tokenHash,
    stale,
  );
  db.run(
    "UPDATE players SET last_seen_at = ? WHERE id = ? AND last_seen_at < ?",
    iso,
    playerId,
    stale,
  );
}

/**
 * Resolves the bearer token on every `/api/*` request and leaves `player` unset when there is
 * none — `GET /api/leaderboard` wants the caller when it has one and works fine without.
 */
export function authenticate(
  db: Db,
  now: () => Date,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = bearerToken(c.req.header("Authorization"));
    if (token) {
      const hash = hashToken(token);
      const player = db.get<PlayerRow>(
        "SELECT p.id, p.nickname, p.provider FROM sessions s " +
          "JOIN players p ON p.id = s.player_id WHERE s.token_hash = ?",
        hash,
      );
      if (player) {
        c.set("player", player);
        touch(db, hash, player.id, now());
      }
    }
    await next();
  };
}

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("player")) {
    return c.json({ error: "unauthorized" } satisfies ApiError, 401);
  }
  await next();
};

// --- google -------------------------------------------------------------------------------

export interface GoogleIdentity {
  sub: string;
  name?: string;
  email?: string;
  /** the Workspace domain, when the account has one */
  hd?: string;
}

/** Returns null for anything that does not verify; the route turns that into `invalid_token`. */
export type GoogleVerifier = (
  idToken: string,
) => Promise<GoogleIdentity | null>;

export function createGoogleVerifier(clientId: string): GoogleVerifier {
  const client = new OAuth2Client();
  return async (idToken) => {
    try {
      const ticket = await client.verifyIdToken({
        idToken,
        audience: clientId,
      });
      const payload = ticket.getPayload();
      if (!payload?.sub) return null;
      return {
        sub: payload.sub,
        ...(payload.name ? { name: payload.name } : {}),
        ...(payload.email ? { email: payload.email } : {}),
        ...(payload.hd ? { hd: payload.hd } : {}),
      };
    } catch {
      return null;
    }
  };
}
