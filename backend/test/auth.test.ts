import { describe, expect, it } from "vitest";
import type { AuthResponse, Player } from "@venturedle/shared/server";
import { createTestApp, fakeGoogleVerifier } from "./helpers.js";

describe("anonymous mode", () => {
  it("issues a token and a player, and the token identifies them afterwards", async () => {
    const t = createTestApp();
    const res = await t.request("/api/auth/anonymous", {
      method: "POST",
      body: JSON.stringify({ nickname: "  Jess  " }),
    });
    expect(res.status).toBe(200);
    const { token, player } = (await res.json()) as AuthResponse;
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(player).toMatchObject({ nickname: "Jess", provider: "anonymous" });
    expect(player.id).toMatch(/^anon:[\w-]{22}$/);

    const me = await t.request("/api/me", { token });
    expect(await me.json()).toEqual(player);
  });

  it("rejects an unusable nickname and a body that is not the right shape", async () => {
    const t = createTestApp();
    const post = (body: unknown) =>
      t.request("/api/auth/anonymous", {
        method: "POST",
        body: JSON.stringify(body),
      });

    expect(await (await post({ nickname: " x " })).json()).toMatchObject({
      error: "nickname_invalid",
    });
    expect(
      await (await post({ nickname: "y".repeat(25) })).json(),
    ).toMatchObject({
      error: "nickname_invalid",
    });
    // Control characters are stripped before the length check.
    const bell = String.fromCharCode(7);
    expect(
      await (await post({ nickname: `J${bell}ess` })).json(),
    ).toMatchObject({
      player: { nickname: "Jess" },
    });
    expect(await (await post({ nickname: `a${bell}` })).json()).toMatchObject({
      error: "nickname_invalid",
    });
    expect(await (await post({ nick: "Jess" })).json()).toMatchObject({
      error: "invalid_body",
    });
    expect((await post({ nickname: 12 })).status).toBe(400);
  });

  it("refuses the google endpoint when it is not the configured mode", async () => {
    const t = createTestApp();
    const res = await t.request("/api/auth/google", {
      method: "POST",
      body: JSON.stringify({ idToken: "anything" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "auth_mode_mismatch" });
  });
});

describe("sessions", () => {
  it("401s without a token and with an unknown one", async () => {
    const t = createTestApp();
    expect((await t.request("/api/me")).status).toBe(401);
    const bad = await t.request("/api/me", { token: "not-a-real-token" });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "unauthorized" });
  });

  it("signs out only the device that asked", async () => {
    const t = createTestApp();
    const first = await t.signUp("Jess");
    const second = await t.request("/api/auth/anonymous", {
      method: "POST",
      body: JSON.stringify({ nickname: "Jess" }),
    });
    const other = ((await second.json()) as AuthResponse).token;

    expect(
      (await t.request("/api/auth/session", { method: "DELETE", token: first }))
        .status,
    ).toBe(204);
    expect((await t.request("/api/me", { token: first })).status).toBe(401);
    expect((await t.request("/api/me", { token: other })).status).toBe(200);
  });

  it("renames a player, and keeps refusing an unusable nickname", async () => {
    const t = createTestApp();
    const token = await t.signUp("Jess");

    const res = await t.request("/api/me", {
      method: "PATCH",
      token,
      body: JSON.stringify({ nickname: "Jessica" }),
    });
    expect(((await res.json()) as Player).nickname).toBe("Jessica");
    expect(
      ((await (await t.request("/api/me", { token })).json()) as Player)
        .nickname,
    ).toBe("Jessica");

    const bad = await t.request("/api/me", {
      method: "PATCH",
      token,
      body: JSON.stringify({ nickname: "" }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "nickname_invalid" });
  });
});

describe("google mode", () => {
  const IDENTITIES = {
    "good-token": { sub: "1234", name: "Jess Rivero", hd: "acurio.vc" },
    "outsider-token": { sub: "9999", name: "Someone Else", hd: "example.com" },
    "no-domain-token": { sub: "5555", email: "solo@gmail.com" },
  };

  function googleApp(allowedDomain?: string) {
    return createTestApp({
      auth: {
        mode: "google",
        clientId: "client-123",
        ...(allowedDomain ? { allowedDomain } : {}),
        verify: fakeGoogleVerifier(IDENTITIES),
      },
    });
  }

  function exchange(t: ReturnType<typeof googleApp>, idToken: string) {
    return t.request("/api/auth/google", {
      method: "POST",
      body: JSON.stringify({ idToken }),
    });
  }

  it("exchanges a verified id token for a session, and resolves to the same player next time", async () => {
    const t = googleApp("acurio.vc");
    const first = (await (
      await exchange(t, "good-token")
    ).json()) as AuthResponse;
    expect(first.player).toEqual({
      id: "google:1234",
      nickname: "Jess Rivero",
      provider: "google",
    });

    // A rename must survive the next sign-in.
    await t.request("/api/me", {
      method: "PATCH",
      token: first.token,
      body: JSON.stringify({ nickname: "JDR" }),
    });
    const second = (await (
      await exchange(t, "good-token")
    ).json()) as AuthResponse;
    expect(second.player).toMatchObject({ id: "google:1234", nickname: "JDR" });
    expect(second.token).not.toBe(first.token);
    expect((await t.request("/api/me", { token: first.token })).status).toBe(
      200,
    );
  });

  it("400s (not 401s) on a token that does not verify", async () => {
    const t = googleApp();
    const res = await exchange(t, "forged");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });

  it("403s an account outside GOOGLE_ALLOWED_DOMAIN, including one with no domain at all", async () => {
    const t = googleApp("acurio.vc");
    const outsider = await exchange(t, "outsider-token");
    expect(outsider.status).toBe(403);
    expect(await outsider.json()).toMatchObject({ error: "forbidden_domain" });
    expect((await exchange(t, "no-domain-token")).status).toBe(403);

    // Without the lock, the same accounts are welcome; the nickname falls back to the email.
    const open = googleApp();
    const res = (await (
      await exchange(open, "no-domain-token")
    ).json()) as AuthResponse;
    expect(res.player).toMatchObject({ id: "google:5555", nickname: "solo" });
  });

  it("refuses the anonymous endpoint", async () => {
    const t = googleApp();
    const res = await t.request("/api/auth/anonymous", {
      method: "POST",
      body: JSON.stringify({ nickname: "Jess" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "auth_mode_mismatch" });
  });
});

describe("rate limiting", () => {
  it("allows 20 sign-ins a minute per IP, then 429s until the bucket refills", async () => {
    const t = createTestApp();
    const signUp = () =>
      t.request("/api/auth/anonymous", {
        method: "POST",
        body: JSON.stringify({ nickname: "Jess" }),
        headers: { "X-Forwarded-For": "203.0.113.7, 10.0.0.1" },
      });

    for (let i = 0; i < 20; i++) expect((await signUp()).status).toBe(200);
    const limited = await signUp();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });

    // A different IP has its own bucket.
    const other = await t.request("/api/auth/anonymous", {
      method: "POST",
      body: JSON.stringify({ nickname: "Sam" }),
      headers: { "X-Forwarded-For": "198.51.100.4" },
    });
    expect(other.status).toBe(200);

    t.advance(60_000);
    expect((await signUp()).status).toBe(200);
  });

  it("does not rate limit the authenticated endpoints", async () => {
    const t = createTestApp();
    const token = await t.signUp("Jess");
    for (let i = 0; i < 30; i++) {
      expect((await t.request("/api/me", { token })).status).toBe(200);
    }
  });
});
