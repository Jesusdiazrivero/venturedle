/**
 * The pipeline: domains file → Harmonic → evidence → LLM → merge → dated schedule.
 *
 * Domains are fetched with bounded concurrency but reported strictly in input order, because a
 * rejection does not consume a date and therefore shifts every company after it.
 */
import { readFile } from "node:fs/promises";
import {
  CompaniesFileSchema,
  FUNDING_BUCKETS,
  HEADCOUNT_BUCKETS,
  bucketOf,
  type Company,
} from "@venturedle/shared/server";
import { toEvidence, toFacts, type HarmonicClient } from "./harmonic.js";
import { LlmInvalidOutputError, type LlmClient } from "./llm.js";
import {
  addUtcDays,
  assignDates,
  buildRecord,
  mapConcurrent,
  readDomainsFile,
  rejectedPathFor,
  relativeToRoot,
  resolveFromRoot,
  writeCompaniesFile,
  writeRejected,
  type Rejection,
  type RejectionReason,
  type UndatedCompany,
} from "./tools.js";

/** Harmonic is the slow part and it rate-limits; three in flight is polite and fast enough. */
const CONCURRENCY = 3;

export interface ExtractOptions {
  /** path to the domains file, relative to the repo root */
  domains: string;
  /** the first puzzle date, YYYY-MM-DD */
  start: string;
  /** where to write the schedule, relative to the repo root */
  out: string;
}

/** The two external edges. `cli.ts` builds them from the environment; tests pass their own. */
export interface Clients {
  harmonic: HarmonicClient;
  llm: LlmClient;
}

type Outcome =
  | { ok: true; record: UndatedCompany; lowConfidence: boolean }
  | { ok: false; reason: RejectionReason; harmonicId?: number };

async function processDomain(
  domain: string,
  harmonic: HarmonicClient,
  llm: LlmClient,
): Promise<Outcome> {
  const fetched = await harmonic.fetchCompany(domain);
  if (!fetched.ok) return { ok: false, reason: fetched.reason };

  const facts = toFacts(domain, fetched.body);
  const id =
    facts.harmonicId === undefined ? {} : { harmonicId: facts.harmonicId };
  // Checked here as well as inside buildRecord: a domain we are going to reject for a missing
  // number should not cost a model call.
  if (facts.headcount === null)
    return { ok: false, reason: "missing_headcount", ...id };
  if (facts.totalFundingUsd === null)
    return { ok: false, reason: "missing_funding_total", ...id };

  let extraction;
  try {
    extraction = await llm.extract(toEvidence(domain, fetched.body));
  } catch (err) {
    if (err instanceof LlmInvalidOutputError) {
      return { ok: false, reason: "llm_invalid_output", ...id };
    }
    throw err;
  }

  const built = buildRecord({
    domain,
    facts,
    extraction,
    harmonicFetchedAt: fetched.fetchedAt,
    llmLabel: llm.label,
  });
  if (!built.ok) return { ok: false, reason: built.reason, ...id };
  return {
    ok: true,
    record: built.record,
    lowConfidence: extraction.confidence === "low",
  };
}

function describe(record: UndatedCompany): string {
  return [
    record.sectors.join(", "),
    record.hqCountry,
    String(record.foundedYear),
    record.fundingStage,
    bucketOf(record.totalFundingUsd, FUNDING_BUCKETS).label,
    bucketOf(record.headcount, HEADCOUNT_BUCKETS).label,
  ].join(" · ");
}

export async function extract(
  { domains: domainsFile, start, out }: ExtractOptions,
  { harmonic, llm }: Clients,
): Promise<void> {
  const outFile = resolveFromRoot(out);
  const domains = await readDomainsFile(resolveFromRoot(domainsFile));

  console.log(
    `Extracting ${domains.length} domains with ${llm.label}, starting ${start}`,
  );

  const outcomes = await mapConcurrent(domains, CONCURRENCY, (domain) =>
    processDomain(domain, harmonic, llm),
  );

  const accepted: UndatedCompany[] = [];
  const rejected: Rejection[] = [];
  const width = Math.max(...domains.map((d) => d.length));
  outcomes.forEach((outcome, i) => {
    const domain = domains[i]!;
    if (!outcome.ok) {
      rejected.push({
        domain,
        reason: outcome.reason,
        ...(outcome.harmonicId === undefined
          ? {}
          : { harmonicId: outcome.harmonicId }),
      });
      console.log(`✘ ${domain.padEnd(width)}  rejected: ${outcome.reason}`);
      return;
    }
    // `accepted.length` is the index this record is about to get — the same arithmetic
    // `assignDates` does below.
    const date = addUtcDays(start, accepted.length);
    accepted.push(outcome.record);
    console.log(
      `✔ ${domain.padEnd(width)}  → ${date}  ${outcome.record.name.padEnd(16)} ` +
        `${describe(outcome.record)}${outcome.lowConfidence ? "  ⚠ low confidence" : ""}`,
    );
  });

  const rejectedFile = rejectedPathFor(outFile);
  await writeRejected(rejectedFile, rejected);
  if (accepted.length === 0) {
    throw new Error(
      `every domain was rejected — see ${relativeToRoot(rejectedFile)}`,
    );
  }

  const companies = assignDates(accepted, start) as Company[];
  await writeCompaniesFile(outFile, companies, start);
  console.log(
    `Wrote ${companies.length} companies to ${relativeToRoot(outFile)} ` +
      `(${companies[0]!.date} → ${companies[companies.length - 1]!.date}). ` +
      `${rejected.length} rejected → ${relativeToRoot(rejectedFile)}`,
  );
  if (rejected.length > 0) {
    console.log(
      "⚠ Rejections shift the schedule. Fix or remove them in domains.txt and re-run.",
    );
  }
}

export async function validate(file: string): Promise<void> {
  const resolved = resolveFromRoot(file);
  const parsed = CompaniesFileSchema.safeParse(
    JSON.parse(await readFile(resolved, "utf8")),
  );
  if (!parsed.success) {
    console.error(
      `✘ ${relativeToRoot(resolved)} is not a valid companies file:`,
    );
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }
  const { companies } = parsed.data;
  console.log(
    `✔ ${relativeToRoot(resolved)}: ${companies.length} companies, ` +
      `${companies[0]!.date} → ${companies[companies.length - 1]!.date}`,
  );
}
