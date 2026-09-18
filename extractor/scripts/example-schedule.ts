/**
 * Re-dates the committed example schedule to start today (or `--start`) and writes it to
 * `data/companies.json`, so a production-like `docker compose up` is playable with no API keys.
 *
 *   npm run example-schedule                       # starts today, → data/companies.json
 *   npm run example-schedule -- 2026-10-01 /tmp/x.json
 *
 * It is not a substitute for the extractor: it re-dates 30 hand-written companies, it does not
 * build a schedule from your domains. That needs a Harmonic key and an LLM key.
 */
import { readFile } from "node:fs/promises";
import { parseCompaniesFile } from "@venturedle/shared/server";
import {
  assignDates,
  relativeToRoot,
  resolveFromRoot,
  writeCompaniesFile,
} from "../src/tools.js";

const [, , startArg, outArg] = process.argv;
const start = startArg ?? new Date().toISOString().slice(0, 10);
const source = resolveFromRoot("data/companies.example.json");
const out = resolveFromRoot(outArg ?? "data/companies.json");

const example = parseCompaniesFile(JSON.parse(await readFile(source, "utf8")));
const companies = assignDates(example.companies, start);
await writeCompaniesFile(out, companies, start);

console.log(
  `Wrote ${companies.length} companies to ${relativeToRoot(out)} ` +
    `(${companies[0]!.date} → ${companies[companies.length - 1]!.date}), re-dated from ` +
    `${relativeToRoot(source)}.`,
);
