/**
 * Who the caller is: the two sign-in exchanges, sign-out, and the nickname. Both modes end in
 * `createSession`, which is the seam a third provider would plug into (D6).
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { ApiError, AuthResponse } from "@venturedle/shared/server";
import {
  bearerToken,
  createAnonymousPlayer,
  createSession,
  normaliseNickname,
  requireAuth,
  revokeSession,
  setNickname,
  upsertGooglePlayer,
} from "../auth.js";
import type { AppEnv, Deps } from "../config.js";

const NicknameBody = z.object({ nickname: z.string() });
const GoogleBody = z.object({ idToken: z.string().min(1) });

const RATE_CAPACITY = 20;
const RATE_WINDOW_MS = 60_000;
/** Above this many tracked IPs, drop the ones whose bucket has refilled anyway. */
const RATE_SWEEP_AT = 1000;

/**
 * Caddy is always in front in production and sets `X-Forwarded-For`; on localhost we fall back to
 * the socket. The header is spoofable, which is accepted for a 20/min bucket on a game.
 */
function clientIp(c: Context<AppEnv>): string {
  const forwarded = c.req.header("X-Forwarded-For");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  const incoming = (
    c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  )?.incoming;
  return incoming?.socket?.remoteAddress ?? "unknown";
}

function rateLimit(now: () => Date): MiddlewareHandler<AppEnv> {
  const buckets = new Map<string, { tokens: number; at: number }>();
  return async (c, next) => {
    const at = now().getTime();
    if (buckets.size > RATE_SWEEP_AT) {
      for (const [ip, bucket] of buckets) {
        if (at - bucket.at > RATE_WINDOW_MS) buckets.delete(ip);
      }
    }
    const ip = clientIp(c);
    const bucket = buckets.get(ip) ?? { tokens: RATE_CAPACITY, at };
    const tokens = Math.min(
      RATE_CAPACITY,
      bucket.tokens + ((at - bucket.at) / RATE_WINDOW_MS) * RATE_CAPACITY,
    );
    if (tokens < 1) {
      buckets.set(ip, { tokens, at });
      return c.json({ error: "rate_limited" } satisfies ApiError, 429);
    }
    buckets.set(ip, { tokens: tokens - 1, at });
    await next();
  };
}

async function jsonBody(c: Context<AppEnv>): Promise<unknown> {
  return c.req.json().catch(() => null);
}

export function identityRoutes({ config, db }: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post("/auth/*", rateLimit(config.now));

  app.post("/auth/anonymous", async (c) => {
    if (config.auth.mode !== "anonymous") {
      return c.json({ error: "auth_mode_mismatch" } satisfies ApiError, 400);
    }
    const body = NicknameBody.safeParse(await jsonBody(c));
    if (!body.success) {
      return c.json({ error: "invalid_body" } satisfies ApiError, 400);
    }
    const nickname = normaliseNickname(body.data.nickname);
    if (!nickname) {
      return c.json(
        {
          error: "nickname_invalid",
          message: "2–24 characters after trimming",
        } satisfies ApiError,
        400,
      );
    }
    const player = createAnonymousPlayer(db, nickname, config.now());
    const token = createSession(db, player.id, config.now());
    return c.json({ token, player } satisfies AuthResponse);
  });

  app.post("/auth/google", async (c) => {
    if (config.auth.mode !== "google") {
      return c.json({ error: "auth_mode_mismatch" } satisfies ApiError, 400);
    }
    const body = GoogleBody.safeParse(await jsonBody(c));
    if (!body.success) {
      return c.json({ error: "invalid_body" } satisfies ApiError, 400);
    }
    const identity = await config.auth.verify(body.data.idToken);
    // 400, not 401: a bad ID token is not an expired session, and the SPA must not clear its own.
    if (!identity) {
      return c.json({ error: "invalid_token" } satisfies ApiError, 400);
    }
    const { allowedDomain } = config.auth;
    if (allowedDomain && identity.hd !== allowedDomain) {
      return c.json(
        {
          error: "forbidden_domain",
          message: `this game is limited to @${allowedDomain} accounts`,
        } satisfies ApiError,
        403,
      );
    }
    const player = upsertGooglePlayer(db, identity, config.now());
    const token = createSession(db, player.id, config.now());
    return c.json({ token, player } satisfies AuthResponse);
  });

  app.delete("/auth/session", requireAuth, (c) => {
    revokeSession(db, bearerToken(c.req.header("Authorization"))!);
    return c.body(null, 204);
  });

  app.get("/me", requireAuth, (c) => c.json(c.get("player")!));

  app.patch("/me", requireAuth, async (c) => {
    const body = NicknameBody.safeParse(await jsonBody(c));
    if (!body.success) {
      return c.json({ error: "invalid_body" } satisfies ApiError, 400);
    }
    const nickname = normaliseNickname(body.data.nickname);
    if (!nickname) {
      return c.json(
        {
          error: "nickname_invalid",
          message: "2–24 characters after trimming",
        } satisfies ApiError,
        400,
      );
    }
    return c.json(setNickname(db, c.get("player")!.id, nickname));
  });

  return app;
}
