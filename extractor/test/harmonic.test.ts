import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createHarmonicClient,
  createMockHarmonicClient,
} from "../src/harmonic.js";
import { AbortRunError } from "../src/types.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

let server: FixtureServer;
const tempDirs: string[] = [];

async function cacheDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "venturedle-cache-"));
  tempDirs.push(dir);
  return dir;
}

function client(
  overrides: Partial<Parameters<typeof createHarmonicClient>[0]> = {},
) {
  return createHarmonicClient({
    apiKey: "test-key",
    baseUrl: server.url,
    cacheDir: null,
    sleep: async () => {}, // never actually wait in tests
    ...overrides,
  });
}

beforeAll(async () => {
  server = await startFixtureServer();
});

afterEach(() => server.reset());

afterAll(async () => {
  await server.close();
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("fetchCompany", () => {
  it("returns the raw body for a known domain", async () => {
    const result = await client().fetchCompany("klarna.com");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.body as { name: string }).name).toBe("Klarna");
    expect(result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(server.requests).toEqual(["klarna.com"]);
  });

  it("rejects an unknown domain with harmonic_not_found", async () => {
    expect(await client().fetchCompany("stealthco.xyz")).toEqual({
      ok: false,
      reason: "harmonic_not_found",
    });
  });

  it("treats a 200 carrying id: -1 as not found", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ id: -1 }), {
        status: 200,
      })) as typeof fetch;
    const result = await client({ fetchImpl }).fetchCompany("ghost.com");
    expect(result).toEqual({ ok: false, reason: "harmonic_not_found" });
  });

  it("aborts the whole run on 401 and on 403", async () => {
    for (const status of [401, 403]) {
      const local = await startFixtureServer({ failWith: [status] });
      await expect(
        client({ baseUrl: local.url }).fetchCompany("klarna.com"),
      ).rejects.toBeInstanceOf(AbortRunError);
      await local.close();
    }
  });

  it("backs off through 429s and then succeeds", async () => {
    const local = await startFixtureServer({ failWith: [429, 429] });
    const result = await client({ baseUrl: local.url }).fetchCompany(
      "klarna.com",
    );
    expect(result.ok).toBe(true);
    expect(local.requests).toHaveLength(3);
    await local.close();
  });

  it("gives up on a domain after five 429s", async () => {
    const local = await startFixtureServer({
      failWith: [429, 429, 429, 429, 429, 429],
    });
    expect(
      await client({ baseUrl: local.url }).fetchCompany("klarna.com"),
    ).toEqual({
      ok: false,
      reason: "harmonic_rate_limited",
    });
    await local.close();
  });

  it("retries a 5xx and then succeeds", async () => {
    const local = await startFixtureServer({ failWith: [503, 500] });
    expect(
      (await client({ baseUrl: local.url }).fetchCompany("klarna.com")).ok,
    ).toBe(true);
    await local.close();
  });

  it("gives up on a domain after repeated 5xx", async () => {
    const local = await startFixtureServer({
      failWith: [500, 500, 500, 500, 500],
    });
    expect(
      await client({ baseUrl: local.url }).fetchCompany("klarna.com"),
    ).toEqual({
      ok: false,
      reason: "harmonic_error",
    });
    await local.close();
  });
});

describe("the disk cache", () => {
  it("serves the second call without a request", async () => {
    const dir = await cacheDir();
    const cached = client({ cacheDir: dir });
    const first = await cached.fetchCompany("klarna.com");
    server.reset();
    const second = await cached.fetchCompany("klarna.com");
    expect(second).toEqual(first);
    expect(server.requests).toEqual([]);
  });

  it("honours a cached 404", async () => {
    const dir = await cacheDir();
    const cached = client({ cacheDir: dir });
    await cached.fetchCompany("stealthco.xyz");
    server.reset();
    expect(await cached.fetchCompany("stealthco.xyz")).toEqual({
      ok: false,
      reason: "harmonic_not_found",
    });
    expect(server.requests).toEqual([]);
  });

  it("refetches when caching is off (--no-cache)", async () => {
    const uncached = client({ cacheDir: null });
    await uncached.fetchCompany("klarna.com");
    await uncached.fetchCompany("klarna.com");
    expect(server.requests).toEqual(["klarna.com", "klarna.com"]);
  });
});

describe("the mock client", () => {
  it("invents a complete, deterministic company without any network", async () => {
    const mock = createMockHarmonicClient();
    const first = await mock.fetchCompany("example.com");
    expect(first).toEqual(await mock.fetchCompany("example.com"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const body = first.body as {
      name: string;
      headcount: number;
      funding: { funding_total: number };
    };
    expect(body.name).toBe("Example");
    expect(body.headcount).toBeGreaterThan(0);
    expect(body.funding.funding_total).toBeGreaterThan(0);
    expect(server.requests).toEqual([]);
  });

  it("gives different domains different companies", async () => {
    const mock = createMockHarmonicClient();
    const a = await mock.fetchCompany("alpha.com");
    const b = await mock.fetchCompany("beta.io");
    expect(a).not.toEqual(b);
  });
});
