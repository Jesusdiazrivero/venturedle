import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Invariant 1 in CLAUDE.md is enforced structurally: `Company` is exported from
 * `@venturedle/shared/server` only, so the SPA cannot import it. `tsc` is the real check
 * (`import type { Company } from "@venturedle/shared"` is TS2305); this test just makes an
 * accidental re-export from the client entry fail loudly and immediately.
 */
const read = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../src/${name}`, import.meta.url)),
    "utf8",
  );

describe("shared entry points", () => {
  it("never exports Company, the zod schemas or the scoring functions from the client entry", () => {
    const index = read("index.ts");
    const exported = index.replace(/\/\*[\s\S]*?\*\//g, ""); // ignore the doc comment
    expect(exported).not.toMatch(/\bCompany\b(?!Lite)/);
    expect(exported).not.toMatch(/CompanySchema|CompaniesFileSchema/);
    expect(exported).not.toMatch(/evaluateGuess|buildShareText/);
    expect(exported).not.toMatch(/from "\.\/scoring\.js"/);
  });

  it("exports CompanyLite from the client entry — that is all the SPA gets", () => {
    expect(read("index.ts")).toMatch(/CompanyLite/);
  });

  it("re-exports the whole client entry from the server entry", () => {
    expect(read("server.ts")).toMatch(/export \* from "\.\/index\.js"/);
    expect(read("server.ts")).toMatch(/evaluateGuess/);
    expect(read("server.ts")).toMatch(/CompaniesFileSchema/);
  });
});
