import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createHarmonicClient,
  createMockHarmonicClient,
  toEvidence,
  toFacts,
} from "../src/harmonic.js";
import { AbortRunError } from "../src/tools.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

let server: FixtureServer;

function client(
  overrides: Partial<Parameters<typeof createHarmonicClient>[0]> = {},
) {
  return createHarmonicClient({
    apiKey: "test-key",
    baseUrl: server.url,
    sleep: async () => {}, // never actually wait in tests
    ...overrides,
  });
}

beforeAll(async () => {
  server = await startFixtureServer();
});

afterEach(() => server.reset());

afterAll(() => server.close());

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
    expect(await client({ fetchImpl }).fetchCompany("ghost.com")).toEqual({
      ok: false,
      reason: "harmonic_not_found",
    });
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
    expect(
      (await client({ baseUrl: local.url }).fetchCompany("klarna.com")).ok,
    ).toBe(true);
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

const snake = {
  id: 481523,
  name: "Klarna",
  logo_url: "https://assets.harmonic.ai/klarna.png",
  description: "Klarna offers a global payments network.",
  website: { domain: "klarna.com" },
  headcount: 4585,
  funding: {
    funding_total: 9460186174,
    funding_stage: "EXITED",
    funding_rounds: [
      { funding_round_type: "SERIES_A" },
      { funding_round_type: "IPO" },
    ],
  },
  founding_date: { date: "2005-01-01" },
  location: { country: "Sweden", state: "Stockholm County", city: "Stockholm" },
  tags_v2: ["Fintech", "Payments"],
  customer_type: "B2C",
};

const camel = {
  id: 481523,
  name: "Klarna",
  logoUrl: "https://assets.harmonic.ai/klarna.png",
  description: "Klarna offers a global payments network.",
  website: { domain: "klarna.com" },
  headcount: 4585,
  funding: {
    fundingTotal: 9460186174,
    fundingStage: "EXITED",
    fundingRounds: [
      { fundingRoundType: "SERIES_A" },
      { fundingRoundType: "IPO" },
    ],
  },
  foundingDate: { date: "2005-01-01" },
  location: { country: "Sweden", state: "Stockholm County", city: "Stockholm" },
  tagsV2: ["Fintech", "Payments"],
  customerType: "B2C",
};

describe("toEvidence", () => {
  it("produces the same evidence from snake_case and camelCase", () => {
    expect(toEvidence("klarna.com", camel)).toEqual(
      toEvidence("klarna.com", snake),
    );
  });

  it("maps every field we care about", () => {
    expect(toEvidence("klarna.com", snake)).toEqual({
      domain: "klarna.com",
      name: "Klarna",
      description: "Klarna offers a global payments network.",
      tags: ["Fintech", "Payments"],
      customerType: "B2C",
      location: {
        country: "Sweden",
        state: "Stockholm County",
        city: "Stockholm",
      },
      foundingDate: "2005-01-01",
      funding: {
        stageRaw: "EXITED",
        totalUsd: 9460186174,
        roundTypes: ["SERIES_A", "IPO"],
      },
      headcount: 4585,
    });
  });

  it("flattens tags_v2 given as objects and de-duplicates", () => {
    const raw = {
      ...snake,
      tags_v2: [
        { type: "INDUSTRY", display_value: "Fintech" },
        { type: "PRODUCT", displayValue: "Payments" },
        { type: "DUPLICATE", display_value: "Fintech" },
        { type: "EMPTY" },
      ],
    };
    expect(toEvidence("klarna.com", raw).tags).toEqual(["Fintech", "Payments"]);
  });

  it("joins an array customer_type", () => {
    expect(
      toEvidence("x.com", { ...snake, customer_type: ["B2C", "B2B"] })
        .customerType,
    ).toBe("B2C, B2B");
  });

  it("trims an ISO timestamp founding date to a calendar date", () => {
    expect(
      toEvidence("x.com", {
        ...snake,
        founding_date: { date: "2005-01-01T00:00:00Z" },
      }).foundingDate,
    ).toBe("2005-01-01");
  });

  it("nulls everything missing rather than inventing it", () => {
    expect(toEvidence("ghost.com", {})).toEqual({
      domain: "ghost.com",
      name: "Ghost", // the only fallback: the domain label
      description: null,
      tags: [],
      customerType: null,
      location: { country: null, state: null, city: null },
      foundingDate: null,
      funding: { stageRaw: null, totalUsd: null, roundTypes: [] },
      headcount: null,
    });
  });
});

describe("toFacts", () => {
  it("reads the numbers from either casing", () => {
    expect(toFacts("klarna.com", camel)).toEqual(toFacts("klarna.com", snake));
    expect(toFacts("klarna.com", snake)).toEqual({
      harmonicId: 481523,
      name: "Klarna",
      logoUrl: "https://assets.harmonic.ai/klarna.png",
      headcount: 4585,
      totalFundingUsd: 9460186174,
      foundedYear: 2005,
    });
  });

  it("falls back to a favicon when Harmonic has no logo", () => {
    expect(toFacts("klarna.com", { ...snake, logo_url: null }).logoUrl).toBe(
      "https://www.google.com/s2/favicons?domain=klarna.com&sz=128",
    );
  });

  it("accepts a funding total serialised as a string", () => {
    expect(
      toFacts("x.com", { funding: { funding_total: "12000000" } })
        .totalFundingUsd,
    ).toBe(12_000_000);
  });

  it("reports missing numbers as null — they are never guessed", () => {
    const facts = toFacts("ghost.com", { id: 1, name: "Ghost" });
    expect(facts.headcount).toBeNull();
    expect(facts.totalFundingUsd).toBeNull();
    expect(facts.foundedYear).toBeNull();
  });
});

describe("the mock client", () => {
  it("invents a complete, deterministic company without any network", async () => {
    const mock = createMockHarmonicClient();
    const first = await mock.fetchCompany("example.com");
    expect(first).toEqual(await mock.fetchCompany("example.com"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const facts = toFacts("example.com", first.body);
    expect(facts.name).toBe("Example");
    expect(facts.headcount).toBeGreaterThan(0);
    expect(facts.totalFundingUsd).toBeGreaterThan(0);
    expect(server.requests).toEqual([]);
  });

  it("gives different domains different companies", async () => {
    const mock = createMockHarmonicClient();
    expect(await mock.fetchCompany("alpha.com")).not.toEqual(
      await mock.fetchCompany("beta.io"),
    );
  });
});
