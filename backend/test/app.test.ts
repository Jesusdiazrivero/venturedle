import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AppConfig,
  CompanyLite,
  HealthResponse,
  PuzzleInfo,
} from "@venturedle/shared/server";
import { loadConfig } from "../src/config.js";
import {
  COMPANIES,
  DAY2,
  createTestApp,
  fakeGoogleVerifier,
} from "./helpers.js";

describe("loadConfig", () => {
  const root = "/srv/app";

  it("resolves every path against the repo root", () => {
    const config = loadConfig({ INIT_CWD: root });
    expect(config.port).toBe(8080);
    expect(config.dbFile).toBe("/srv/app/data/venturedle.db");
    expect(config.companiesFile).toBe("/srv/app/data/companies.json");
    expect(config.staticDir).toBe("/srv/app/frontend/dist");
    expect(config.auth.mode).toBe("anonymous");
  });

  it("puts the database next to DATA_DIR but lets COMPANIES_FILE roam", () => {
    const config = loadConfig({
      INIT_CWD: root,
      DATA_DIR: "/data",
      COMPANIES_FILE: "data/companies.example.json",
    });
    expect(config.dbFile).toBe("/data/venturedle.db");
    expect(config.companiesFile).toBe("/srv/app/data/companies.example.json");
  });

  it("refuses DEV_TODAY in production", () => {
    expect(() =>
      loadConfig({ INIT_CWD: root, DEV_TODAY: DAY2, NODE_ENV: "production" }),
    ).toThrow(/DEV_TODAY/);
  });

  it("refuses a DEV_TODAY that is not a calendar date", () => {
    expect(() =>
      loadConfig({ INIT_CWD: root, DEV_TODAY: "2026-02-30" }),
    ).toThrow(/DEV_TODAY/);
  });

  it("refuses google mode without a client id, and an unknown mode", () => {
    expect(() => loadConfig({ INIT_CWD: root, AUTH_MODE: "google" })).toThrow(
      /GOOGLE_CLIENT_ID/,
    );
    expect(() => loadConfig({ INIT_CWD: root, AUTH_MODE: "saml" })).toThrow(
      /AUTH_MODE/,
    );
  });
});

describe("public endpoints", () => {
  it("reports health", async () => {
    const t = createTestApp();
    const body = (await (
      await t.request("/api/health")
    ).json()) as HealthResponse;
    expect(body.ok).toBe(true);
    expect(body.companies).toBe(COMPANIES.length);
    expect(body.today).toBe(DAY2);
  });

  it("tells the SPA which auth mode to render", async () => {
    const anon = createTestApp();
    expect(await (await anon.request("/api/config")).json()).toEqual({
      authMode: "anonymous",
    } satisfies AppConfig);

    const google = createTestApp({
      auth: {
        mode: "google",
        clientId: "client-123",
        allowedDomain: "example.com",
        verify: fakeGoogleVerifier({}),
      },
    });
    expect(await (await google.request("/api/config")).json()).toEqual({
      authMode: "google",
      googleClientId: "client-123",
      googleAllowedDomain: "example.com",
    } satisfies AppConfig);
  });

  it("serves the whole pool sorted by name, cacheable, with no answer fields", async () => {
    const t = createTestApp();
    const res = await t.request("/api/companies");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    const pool = (await res.json()) as CompanyLite[];
    expect(pool.map((c) => c.name)).toEqual([
      "Alpha",
      "Beta",
      "Beta Twin",
      "Gamma",
    ]);
    expect(Object.keys(pool[0]!).sort()).toEqual(["id", "logoUrl", "name"]);
  });

  it("describes today's puzzle, and says so when there is none", async () => {
    const t = createTestApp();
    const info = (await (
      await t.request("/api/puzzle/today")
    ).json()) as PuzzleInfo;
    expect(info).toMatchObject({ date: DAY2, exists: true, number: 2 });
    expect(info.nextPuzzleAt).toBe("2026-03-03T00:00:00.000Z");

    t.setToday("2026-06-01");
    const none = (await (
      await t.request("/api/puzzle/today")
    ).json()) as PuzzleInfo;
    expect(none).toMatchObject({ date: "2026-06-01", exists: false });
    expect(none.number).toBeUndefined();
  });

  it("sets the headers Google Identity Services needs", async () => {
    const t = createTestApp();
    const res = await t.request("/api/health");
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe(
      "same-origin-allow-popups",
    );
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("answers an unknown /api path with not_found, not the SPA", async () => {
    const t = createTestApp();
    const res = await t.request("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});

describe("static serving", () => {
  /** Absolute, as in Docker — older serve-static versions mishandled that. */
  function buildSpa(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "venturedle-spa-"));
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(
      path.join(dir, "index.html"),
      "<!doctype html><title>SPA</title>",
    );
    writeFileSync(
      path.join(dir, "assets", "index-abc123.js"),
      "console.log(1)",
    );
    return dir;
  }

  it("serves real files, hashed assets immutably, and index.html for SPA routes", async () => {
    const t = createTestApp({ staticDir: buildSpa() });

    const index = await t.request("/");
    expect(await index.text()).toContain("<title>SPA</title>");

    const asset = await t.request("/assets/index-abc123.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );

    const route = await t.request("/leaderboard");
    expect(await route.text()).toContain("<title>SPA</title>");
    expect(route.headers.get("Cache-Control")).toBe("no-cache");

    // A missing hashed asset falls through to index.html — which must not inherit the year.
    const missing = await t.request("/assets/gone-000000.js");
    expect(missing.headers.get("Cache-Control")).toBe("no-cache");

    // The API still wins over the fallback.
    expect((await t.request("/api/nope")).status).toBe(404);
  });

  it("hints instead of 404ing when there is no built SPA", async () => {
    const t = createTestApp();
    const res = await t.request("/");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "venturedle" });
  });
});
