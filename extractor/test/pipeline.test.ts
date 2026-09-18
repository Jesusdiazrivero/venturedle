/**
 * The whole pipeline, in process: the real Harmonic client against a fixture server, and a fake
 * LLM injected through `extract`'s second argument. No network, no keys.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  CompaniesFileSchema,
  type CompaniesFile,
} from "@venturedle/shared/server";
import { createHarmonicClient } from "../src/harmonic.js";
import { extract, type Clients } from "../src/index.js";
import type { Rejection } from "../src/tools.js";
import { createFakeLlm, type FakeLlmOptions } from "./fake-llm.js";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

const DOMAINS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "domains.txt",
);
const START = "2026-10-01";

let server: FixtureServer;
let workDir: string;
let outFile: string;
let log: string[];

async function run(options: FakeLlmOptions = {}): Promise<Clients> {
  const clients: Clients = {
    harmonic: createHarmonicClient({ apiKey: "test-key", baseUrl: server.url }),
    llm: createFakeLlm(options),
  };
  await extract({ domains: DOMAINS, start: START, out: outFile }, clients);
  return clients;
}

async function readOut(): Promise<CompaniesFile> {
  return CompaniesFileSchema.parse(
    JSON.parse(await readFile(outFile, "utf8")),
  ) as CompaniesFile;
}

async function readRejected(): Promise<Rejection[]> {
  return JSON.parse(
    await readFile(path.join(workDir, "rejected.json"), "utf8"),
  );
}

beforeAll(async () => {
  server = await startFixtureServer();
});

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "venturedle-pipeline-"));
  outFile = path.join(workDir, "companies.json");
  log = [];
  vi.spyOn(console, "log").mockImplementation(
    (line: string) => void log.push(line),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  server.reset();
  await rm(workDir, { recursive: true, force: true });
});

afterAll(() => server.close());

describe("extract", () => {
  it("writes one dated record per surviving domain, in input order", async () => {
    await run();
    const file = await readOut();
    expect(file.companies.map((c) => [c.id, c.date])).toEqual([
      ["klarna.com", "2026-10-01"],
      ["revolut.com", "2026-10-02"],
      ["n26.com", "2026-10-03"],
    ]);
    expect(file.startDate).toBe(START);
  });

  it("copies Harmonic's numbers and takes the categories from the model", async () => {
    await run();
    const [klarna] = (await readOut()).companies;
    expect(klarna).toMatchObject({
      name: "Klarna",
      headcount: 4585, // Harmonic
      totalFundingUsd: 9460186174, // Harmonic
      foundedYear: 2005, // Harmonic
      hqCountry: "SE", // model
      region: "Europe", // derived
      sectors: ["Fintech", "Payments"], // model
    });
    expect(klarna?.source?.llm).toBe("fake/fake");
  });

  it("reads tags_v2 given as objects and falls back to a favicon logo", async () => {
    await run();
    const n26 = (await readOut()).companies.find((c) => c.id === "n26.com");
    expect(n26?.logoUrl).toBe(
      "https://www.google.com/s2/favicons?domain=n26.com&sz=128",
    );
  });

  it("records the 404 and the record with no headcount, and gives them no date", async () => {
    await run();
    expect(await readRejected()).toEqual([
      { domain: "stealthco.xyz", reason: "harmonic_not_found" },
      {
        domain: "acme-nodata.io",
        reason: "missing_headcount",
        harmonicId: 999001,
      },
    ]);
  });

  it("does not spend a model call on a domain it is going to reject", async () => {
    const { llm } = await run();
    // stealthco.xyz 404s and acme-nodata.io has no headcount: neither reaches the model.
    // Sorted, because three domains are in flight at once — the call *order* is a race.
    const called = [...(llm as ReturnType<typeof createFakeLlm>).calls].sort();
    expect(called).toEqual(["klarna.com", "n26.com", "revolut.com"]);
  });

  it("rejects a domain whose extraction never satisfies the schema", async () => {
    await run({ invalidFor: ["revolut.com"] });
    expect(await readRejected()).toContainEqual({
      domain: "revolut.com",
      reason: "llm_invalid_output",
      harmonicId: 102994,
    });
    // and the dates close up behind it
    expect((await readOut()).companies.map((c) => [c.id, c.date])).toEqual([
      ["klarna.com", "2026-10-01"],
      ["n26.com", "2026-10-02"],
    ]);
  });

  it("keeps a low-confidence extraction, flagged in the log and in the notes", async () => {
    await run({ lowConfidenceFor: ["klarna.com"] });
    expect(log.find((l) => l.includes("klarna.com"))).toContain(
      "⚠ low confidence",
    );
    const [klarna] = (await readOut()).companies;
    expect(klarna?.source?.notes).toBe(
      "low confidence — canned test extraction",
    );
  });

  it("logs one line per domain, in input order, and warns that rejections shift the schedule", async () => {
    await run();
    const lines = log.filter((l) => l.startsWith("✔") || l.startsWith("✘"));
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(
      /^✔ klarna\.com\s+→ 2026-10-01\s+Klarna\s+Fintech, Payments · SE · 2005 · Series D\+ · >\$1B · 1,001–5,000/,
    );
    expect(lines[2]).toMatch(
      /^✘ stealthco\.xyz\s+rejected: harmonic_not_found/,
    );
    expect(log.join("\n")).toContain("Wrote 3 companies");
    expect(log.join("\n")).toContain("2 rejected");
    expect(log.join("\n")).toContain("⚠ Rejections shift the schedule.");
  });

  it("reproduces the same schedule on a second run", async () => {
    // Only the timestamps move — `generatedAt` and `source.harmonicFetchedAt`.
    const undated = (file: CompaniesFile) =>
      file.companies.map(({ source, ...rest }) => ({
        ...rest,
        source: { ...source, harmonicFetchedAt: undefined },
      }));

    await run();
    const before = undated(await readOut());
    await run();
    expect(undated(await readOut())).toEqual(before);
  });

  it("fails loudly when every domain is rejected", async () => {
    await expect(
      run({ invalidFor: ["klarna.com", "revolut.com", "n26.com"] }),
    ).rejects.toThrow(/every domain was rejected/);
    expect(await readRejected()).toHaveLength(5);
  });
});
