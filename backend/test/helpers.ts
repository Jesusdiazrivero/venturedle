/**
 * One app per test: an in-memory database, a `companies.json` in a temp directory, and a clock the
 * test owns. Nothing here reaches the network; the Google verifier is a fake that lives in this
 * file rather than in `src/` (D14).
 */
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import type { CompaniesFile, Company } from "@venturedle/shared/server";
import type { GoogleIdentity, GoogleVerifier } from "../src/auth.js";
import type { AppEnv, AuthConfig, Config } from "../src/config.js";
import { createApp } from "../src/server.js";

export const DAY1 = "2026-03-01";
export const DAY2 = "2026-03-02";
export const DAY3 = "2026-03-03";
export const DAY4 = "2026-03-04";

/** Puzzle #2 by default: the tests pin "today" to DAY2, so `beta.com` is the answer. */
export const COMPANIES: Company[] = [
  {
    id: "alpha.com",
    date: DAY1,
    domain: "alpha.com",
    name: "Alpha",
    logoUrl: "https://example.com/alpha.png",
    sectors: ["Fintech"],
    businessModel: ["B2B"],
    hqCountry: "ES",
    region: "Europe",
    foundedYear: 2015,
    fundingStage: "Series A",
    totalFundingUsd: 30_000_000,
    headcount: 150,
  },
  {
    id: "beta.com",
    date: DAY2,
    domain: "beta.com",
    name: "Beta",
    logoUrl: "https://example.com/beta.png",
    sectors: ["Payments", "Fintech"],
    businessModel: ["B2C"],
    hqCountry: "SE",
    region: "Europe",
    foundedYear: 2010,
    fundingStage: "Series C",
    totalFundingUsd: 900_000_000,
    headcount: 2_000,
  },
  {
    id: "gamma.com",
    date: DAY3,
    domain: "gamma.com",
    name: "Gamma",
    logoUrl: "https://example.com/gamma.png",
    sectors: ["Gaming"],
    businessModel: ["Marketplace"],
    hqCountry: "US",
    region: "North America",
    foundedYear: 2020,
    fundingStage: "Seed",
    totalFundingUsd: 3_000_000,
    headcount: 20,
  },
  // Same seven-tuple as beta.com, different id: guessing it goes all green but is still a miss
  // (invariant 5).
  {
    id: "beta-twin.com",
    date: DAY4,
    domain: "beta-twin.com",
    name: "Beta Twin",
    logoUrl: "https://example.com/twin.png",
    sectors: ["Payments", "Fintech"],
    businessModel: ["B2C"],
    hqCountry: "SE",
    region: "Europe",
    foundedYear: 2010,
    fundingStage: "Series C",
    totalFundingUsd: 900_000_000,
    headcount: 2_000,
  },
];

export function fakeGoogleVerifier(
  identities: Record<string, GoogleIdentity>,
): GoogleVerifier {
  return async (idToken) => identities[idToken] ?? null;
}

export interface TestApp {
  app: Hono<AppEnv>;
  config: Config;
  companiesFile: string;
  /** Move the clock forward; `elapsedMs` and the reload throttle both read it. */
  advance(ms: number): void;
  /** Move the pinned puzzle date (`DEV_TODAY`). */
  setToday(date: string): void;
  /** Replace `companies.json` with a valid schedule and bump its mtime. */
  writeCompanies(companies: Company[]): void;
  /** Replace `companies.json` with arbitrary text — used to test that a bad file is ignored. */
  writeRaw(contents: string): void;
  request(
    path: string,
    init?: RequestInit & { token?: string },
  ): Promise<Response>;
  /** Sign up anonymously and return the bearer token. */
  signUp(nickname: string): Promise<string>;
}

export interface TestAppOptions {
  today?: string;
  auth?: AuthConfig;
  publicUrl?: string;
  companies?: Company[];
  staticDir?: string;
}

function companiesFileFor(companies: Company[]): CompaniesFile {
  return {
    version: 1,
    generatedAt: "2026-02-01T00:00:00.000Z",
    startDate: companies[0]!.date,
    companies,
  };
}

export function createTestApp(options: TestAppOptions = {}): TestApp {
  const dir = mkdtempSync(path.join(tmpdir(), "venturedle-"));
  const companiesFile = path.join(dir, "companies.json");
  let mtime = 1_700_000_000;

  const write = (contents: string) => {
    writeFileSync(companiesFile, contents);
    // Explicit mtimes so two writes in the same millisecond still look different to the loader.
    mtime += 60;
    utimesSync(companiesFile, mtime, mtime);
  };
  write(JSON.stringify(companiesFileFor(options.companies ?? COMPANIES)));

  let signUps = 0;
  let now = new Date("2026-03-02T09:00:00.000Z");
  const config: Config = {
    port: 0,
    dbFile: ":memory:",
    companiesFile,
    staticDir: options.staticDir ?? path.join(dir, "no-spa-here"),
    ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
    auth: options.auth ?? { mode: "anonymous" },
    devToday: options.today ?? DAY2,
    now: () => now,
  };

  const { app } = createApp(config);

  const request: TestApp["request"] = async (p, init = {}) => {
    const { token, ...rest } = init;
    return app.request(p, {
      ...rest,
      headers: {
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...rest.headers,
      },
    });
  };

  return {
    app,
    config,
    companiesFile,
    advance: (ms) => {
      now = new Date(now.getTime() + ms);
    },
    setToday: (date) => {
      config.devToday = date;
    },
    writeCompanies: (companies) =>
      write(JSON.stringify(companiesFileFor(companies))),
    writeRaw: write,
    request,
    async signUp(nickname) {
      const res = await request("/api/auth/anonymous", {
        method: "POST",
        body: JSON.stringify({ nickname }),
        // A fresh IP each time, so the auth rate limit only ever fires in the test that asks for it.
        headers: { "X-Forwarded-For": `198.51.100.${signUps++}` },
      });
      const { token } = (await res.json()) as { token: string };
      return token;
    },
  };
}
