/**
 * The whole CLI, end to end: fixture Harmonic server + mock LLM, no network, no keys. This is the
 * test that would catch a broken pipeline; the unit tests only catch a broken part.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CompaniesFileSchema,
  type CompaniesFile,
} from "@venturedle/shared/server";
import { startFixtureServer, type FixtureServer } from "./fixture-server.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "src", "cli.ts");
const DOMAINS = path.join(here, "fixtures", "domains.txt");
const START = "2026-10-01";

let server: FixtureServer;
let workDir: string;
let outFile: string;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", CLI, ...args],
      {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          INIT_CWD: workDir, // stands in for "the repo root" — .cache and relative paths land here
          HARMONIC_BASE_URL: server.url,
          HARMONIC_API_KEY: "test-key",
          ...env,
        },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: e.code ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

async function readOut(): Promise<CompaniesFile> {
  return CompaniesFileSchema.parse(
    JSON.parse(await readFile(outFile, "utf8")),
  ) as CompaniesFile;
}

let firstRun: RunResult;

beforeAll(async () => {
  server = await startFixtureServer();
  workDir = await mkdtemp(path.join(tmpdir(), "venturedle-e2e-"));
  outFile = path.join(workDir, "data", "companies.json");
  firstRun = await runCli([
    "-d",
    DOMAINS,
    "-s",
    START,
    "-o",
    outFile,
    "--provider",
    "mock",
  ]);
}, 60_000);

afterAll(async () => {
  await server.close();
  await rm(workDir, { recursive: true, force: true });
});

describe("extract", () => {
  it("exits 0", () => {
    expect(firstRun.stderr).toBe("");
    expect(firstRun.code).toBe(0);
  });

  it("writes a valid file with one dated record per surviving domain", async () => {
    const file = await readOut();
    expect(file.companies.map((c) => [c.id, c.date])).toEqual([
      ["klarna.com", "2026-10-01"],
      ["revolut.com", "2026-10-02"],
      ["n26.com", "2026-10-03"],
    ]);
    expect(file.startDate).toBe(START);
  });

  it("copies Harmonic's numbers and normalises the categories", async () => {
    const [klarna] = (await readOut()).companies;
    expect(klarna).toMatchObject({
      name: "Klarna",
      headcount: 4585,
      totalFundingUsd: 9460186174,
      foundedYear: 2005,
      hqCountry: "SE",
      region: "Europe",
      fundingStage: "Public", // EXITED + an IPO round
      sectors: ["Fintech", "Payments"], // "BNPL" is not in the taxonomy
      businessModel: ["B2C"],
    });
    expect(klarna?.source?.llm).toBe("mock/mock");
  });

  it("reads tags_v2 given as objects", async () => {
    const n26 = (await readOut()).companies.find((c) => c.id === "n26.com");
    expect(n26?.sectors).toEqual(["Fintech", "Payments"]);
    expect(n26?.logoUrl).toBe(
      "https://www.google.com/s2/favicons?domain=n26.com&sz=128",
    );
  });

  it("records both rejections, with the reason, and does not give them a date", async () => {
    const rejected = JSON.parse(
      await readFile(path.join(workDir, "data", "rejected.json"), "utf8"),
    );
    expect(rejected).toEqual([
      { domain: "stealthco.xyz", reason: "harmonic_not_found" },
      {
        domain: "acme-nodata.io",
        reason: "missing_headcount",
        harmonicId: 999001,
      },
    ]);
  });

  it("logs one line per domain, in input order, and warns that rejections shift the schedule", () => {
    const lines = firstRun.stdout
      .split("\n")
      .filter((l) => l.startsWith("✔") || l.startsWith("✘"));
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(
      /^✔ klarna\.com\s+→ 2026-10-01\s+Klarna\s+Fintech, Payments · SE · 2005 · Public · >\$1B · 1,001–5,000/,
    );
    expect(lines[2]).toMatch(
      /^✘ stealthco\.xyz\s+rejected: harmonic_not_found/,
    );
    expect(firstRun.stdout).toContain("Wrote 3 companies");
    expect(firstRun.stdout).toContain("2 rejected");
    expect(firstRun.stdout).toContain("⚠ Rejections shift the schedule.");
  });

  it("is deterministic: a second run reproduces the same schedule", async () => {
    // Only the timestamps move — `generatedAt` and `source.harmonicFetchedAt`.
    const undated = (file: CompaniesFile) =>
      file.companies.map(({ source, ...rest }) => ({
        ...rest,
        source: { ...source, harmonicFetchedAt: undefined },
      }));

    const before = undated(await readOut());
    const second = await runCli([
      "-d",
      DOMAINS,
      "-s",
      START,
      "-o",
      outFile,
      "--provider",
      "mock",
    ]);
    expect(second.code).toBe(0);
    expect(undated(await readOut())).toEqual(before);
  }, 60_000);

  it("aborts with exit code 2 when Harmonic rejects the key", async () => {
    const unauthorised = await startFixtureServer({ failWith: [401] });
    const result = await runCli(
      [
        "-d",
        DOMAINS,
        "-s",
        START,
        "-o",
        path.join(workDir, "nope.json"),
        "--provider",
        "mock",
      ],
      { HARMONIC_BASE_URL: unauthorised.url },
    );
    await unauthorised.close();
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/check HARMONIC_API_KEY/);
  }, 60_000);

  it("fails when --domains is missing", async () => {
    const result = await runCli(["-s", START, "--provider", "mock"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--domains is required/);
  }, 60_000);
});

describe("validate", () => {
  it("accepts the file the extractor just wrote", async () => {
    const result = await runCli(["validate", outFile]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("3 companies, 2026-10-01 → 2026-10-03");
  }, 60_000);

  it("exits 1 and explains why for an invalid file", async () => {
    const broken = path.join(workDir, "broken.json");
    const file = await readOut();
    file.companies[1]!.date = file.companies[0]!.date; // duplicate date
    await execFileAsync(process.execPath, [
      "-e",
      `require("fs").writeFileSync(${JSON.stringify(broken)}, ${JSON.stringify(JSON.stringify(file))})`,
    ]);
    const result = await runCli(["validate", broken]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/duplicate date/);
  }, 60_000);
});
