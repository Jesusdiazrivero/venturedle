/**
 * The pure parts of the extractor: paths, the domains file, dates, the merge, the writer. Nothing
 * here does I/O against Harmonic or an LLM, so all of it is directly testable.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CompaniesFileSchema,
  CompanySchema,
  isCalendarDate,
  regionOf,
  type CompaniesFile,
  type Company,
} from "@venturedle/shared/server";
import type { HarmonicFacts } from "./harmonic.js";
import type { Extraction } from "./llm.js";

// --- paths ---------------------------------------------------------------------------------

/** npm sets INIT_CWD to where `npm run` was invoked, which is the repo root in practice. */
export const repoRoot = process.env.INIT_CWD ?? process.cwd();

export function resolveFromRoot(p: string): string {
  return path.resolve(repoRoot, p);
}

/** Paths are printed relative to the root: `data/companies.json`, not a 60-character absolute. */
export function relativeToRoot(file: string): string {
  const rel = path.relative(repoRoot, file);
  return rel && !rel.startsWith("..") ? rel : file;
}

// --- failures ------------------------------------------------------------------------------

/** Why a single domain was dropped. `zod_<path>` is produced by `buildRecord`. */
export type RejectionReason =
  | "harmonic_not_found"
  | "harmonic_rate_limited"
  | "harmonic_error"
  | "missing_headcount"
  | "missing_funding_total"
  | "missing_founded_year"
  | "llm_invalid_output"
  | `zod_${string}`;

export interface Rejection {
  domain: string;
  reason: RejectionReason;
  harmonicId?: number;
}

/**
 * Thrown on 401/403 from Harmonic or from the LLM provider. A bad key must never turn into a file
 * full of rejections, so this unwinds the whole run and exits 2.
 */
export class AbortRunError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "AbortRunError";
  }
}

// --- domains -------------------------------------------------------------------------------

const DOMAIN_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * `https://www.n26.com/about?x=1  # comment` → `n26.com`. Returns null for a blank or
 * comment-only line; `isDomain` decides whether the result is usable.
 */
export function normaliseDomain(raw: string): string | null {
  let s = raw.split("#")[0]!.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  s = s.split("/")[0]!; // path
  s = s.split("?")[0]!; // query on a path-less URL
  s = s.split(":")[0]!; // port
  s = s.replace(/^www\./, "");
  s = s.replace(/\.$/, ""); // fully-qualified trailing dot
  return s || null;
}

export function isDomain(value: string): boolean {
  return DOMAIN_RE.test(value);
}

/** The domain becomes the company id forever, so a duplicate is an error, not a warning. */
export function parseDomainsFile(contents: string): string[] {
  const domains: string[] = [];
  const seen = new Map<string, number>();

  contents.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const domain = normaliseDomain(raw);
    if (domain === null) return;
    if (!isDomain(domain)) {
      throw new Error(
        `line ${line}: "${raw.trim()}" is not a domain (normalised to "${domain}")`,
      );
    }
    const first = seen.get(domain);
    if (first !== undefined) {
      throw new Error(
        `line ${line}: duplicate domain "${domain}" (first seen on line ${first})`,
      );
    }
    seen.set(domain, line);
    domains.push(domain);
  });

  if (domains.length === 0) throw new Error("no domains found");
  return domains;
}

export async function readDomainsFile(file: string): Promise<string[]> {
  try {
    return parseDomainsFile(await readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`${relativeToRoot(file)}: ${(err as Error).message}`);
  }
}

// --- dates ---------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export function addUtcDays(date: string, days: number): string {
  if (!isCalendarDate(date)) throw new Error(`not a calendar date: "${date}"`);
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * Dates go to the records that survived, in input order, so the schedule is always contiguous from
 * `start`. A rejected domain does not consume a date — it shifts everything after it, which is why
 * the CLI shouts about rejections.
 */
export function assignDates<T>(
  records: readonly T[],
  start: string,
): (T & { date: string })[] {
  if (!isCalendarDate(start)) {
    throw new Error(`--start must be a real YYYY-MM-DD date, got "${start}"`);
  }
  return records.map((record, i) => ({
    ...record,
    date: addUtcDays(start, i),
  }));
}

// --- merge ---------------------------------------------------------------------------------

/** `date` is assigned later, once we know which domains survived. */
export type UndatedCompany = Omit<Company, "date">;

export type BuildResult =
  { ok: true; record: UndatedCompany } | { ok: false; reason: RejectionReason };

/** Only ever seen by `CompanySchema` inside this function; `assignDates` overwrites it. */
const PLACEHOLDER_DATE = "1970-01-01";

/**
 * Harmonic's numbers + the LLM's categories → one `Company`, or a rejection. This is where
 * invariant 2 is enforced: a missing number is never guessed.
 */
export function buildRecord(args: {
  domain: string;
  facts: HarmonicFacts;
  extraction: Extraction;
  harmonicFetchedAt: string;
  llmLabel: string;
}): BuildResult {
  const { domain, facts, extraction } = args;
  if (facts.headcount === null)
    return { ok: false, reason: "missing_headcount" };
  if (facts.totalFundingUsd === null)
    return { ok: false, reason: "missing_funding_total" };

  const foundedYear = facts.foundedYear ?? extraction.foundedYear;
  if (foundedYear === null)
    return { ok: false, reason: "missing_founded_year" };

  const candidate: Company = {
    id: domain,
    date: PLACEHOLDER_DATE,
    domain,
    name: facts.name,
    logoUrl: facts.logoUrl,
    sectors: extraction.sectors,
    businessModel: extraction.businessModel,
    hqCountry: extraction.hqCountry,
    region: regionOf(extraction.hqCountry),
    foundedYear,
    fundingStage: extraction.fundingStage,
    totalFundingUsd: Math.round(facts.totalFundingUsd),
    headcount: Math.round(facts.headcount),
    source: {
      ...(facts.harmonicId !== undefined
        ? { harmonicId: facts.harmonicId }
        : {}),
      harmonicFetchedAt: args.harmonicFetchedAt,
      llm: args.llmLabel,
      // Low-confidence extractions are kept but flagged, so the operator can eyeball them.
      notes:
        extraction.confidence === "low"
          ? `low confidence — ${extraction.notes}`
          : extraction.notes,
    },
  };

  const parsed = CompanySchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `zod_${parsed.error.issues[0]?.path.join(".") || "record"}`,
    };
  }

  const { date: _date, ...record } = candidate;
  return { ok: true, record };
}

// --- running -------------------------------------------------------------------------------

/** Bounded concurrency, results in input order. */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++)
        results[i] = await fn(items[i]!);
    }),
  );
  return results;
}

// --- output --------------------------------------------------------------------------------

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  // Pretty-printed with a trailing newline: the schedule is meant to be diffed and hand-edited.
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeCompaniesFile(
  file: string,
  companies: Company[],
  startDate: string,
): Promise<CompaniesFile> {
  const data: CompaniesFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    startDate,
    companies,
  };
  CompaniesFileSchema.parse(data); // never write a file the backend would refuse to start on
  await writeJson(file, data);
  return data;
}

/** Written next to `--out`, and written even when empty so a stale list never misleads. */
export function rejectedPathFor(outFile: string): string {
  return path.join(path.dirname(outFile), "rejected.json");
}

export async function writeRejected(
  file: string,
  rejected: readonly Rejection[],
): Promise<void> {
  await writeJson(file, rejected);
}
