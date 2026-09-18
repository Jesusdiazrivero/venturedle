/**
 * The CLI itself, as a subprocess: flags in, exit code out. The pipeline is tested in process by
 * `pipeline.test.ts`; nothing here needs an LLM, so nothing here has a key.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureServer } from "./fixture-server.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(here, "..", "..");
const CLI = path.join(here, "..", "src", "cli.ts");
const DOMAINS = path.join(here, "fixtures", "domains.txt");

let workDir: string;

async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", CLI, ...args],
      {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          INIT_CWD: REPO_ROOT,
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

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "venturedle-cli-"));
});

afterAll(() => rm(workDir, { recursive: true, force: true }));

describe("validate", () => {
  it("accepts the committed example schedule", async () => {
    const result = await runCli(["validate", "data/companies.example.json"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(
      /✔ data\/companies\.example\.json: \d+ companies, \d{4}-/,
    );
  }, 60_000);

  it("exits 1 and says why for an invalid file", async () => {
    const broken = path.join(workDir, "broken.json");
    await writeFile(
      broken,
      JSON.stringify({
        version: 1,
        generatedAt: "x",
        startDate: "nope",
        companies: [],
      }),
    );
    const result = await runCli(["validate", broken]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/is not a valid companies file/);
    expect(result.stderr).toMatch(/startDate/);
  }, 60_000);
});

describe("extract", () => {
  it("exits 1 when --domains is missing", async () => {
    const result = await runCli([
      "-s",
      "2026-10-01",
      "--provider",
      "anthropic",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--domains is required/);
  }, 60_000);

  it("exits 1 when --start is missing", async () => {
    const result = await runCli(["-d", DOMAINS, "--provider", "anthropic"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/--start is required/);
  }, 60_000);

  it("exits 1 on an unknown provider", async () => {
    const result = await runCli([
      "-d",
      DOMAINS,
      "-s",
      "2026-10-01",
      "--provider",
      "llama",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/unknown --provider "llama"/);
  }, 60_000);

  it("exits 1 when it cannot infer a provider", async () => {
    const result = await runCli(["-d", DOMAINS, "-s", "2026-10-01"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Could not infer --provider/);
  }, 60_000);

  it("exits 1 without a Harmonic key", async () => {
    const result = await runCli(
      ["-d", DOMAINS, "-s", "2026-10-01", "--provider", "anthropic"],
      {
        ANTHROPIC_API_KEY: "test",
      },
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/HARMONIC_API_KEY is not set/);
  }, 60_000);

  it("exits 2 when Harmonic rejects the key — a bad key is not 100 rejections", async () => {
    const unauthorised = await startFixtureServer({ failWith: [401] });
    const result = await runCli(
      [
        "-d",
        DOMAINS,
        "-s",
        "2026-10-01",
        "-o",
        path.join(workDir, "nope.json"),
        "--provider",
        "anthropic",
      ],
      {
        ANTHROPIC_API_KEY: "test",
        HARMONIC_API_KEY: "wrong",
        HARMONIC_BASE_URL: unauthorised.url,
      },
    );
    await unauthorised.close();
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/check HARMONIC_API_KEY/);
  }, 60_000);
});
