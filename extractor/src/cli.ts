/**
 * `npm run extract` — arg parsing, orchestration and logging.
 *
 * Order matters and is visible in the log: domains are processed with bounded concurrency but
 * reported strictly in input order, because a rejection shifts every date after it.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import {
  CompaniesFileSchema,
  FUNDING_BUCKETS,
  HEADCOUNT_BUCKETS,
  bucketOf,
  type Company,
} from "@venturedle/shared/server";
import { readDomainsFile } from "./domains.js";
import { toEvidence, toFacts } from "./evidence.js";
import {
  createHarmonicClient,
  createMockHarmonicClient,
  type HarmonicClient,
} from "./harmonic.js";
import {
  LlmInvalidOutputError,
  createLlmClient,
  type LlmClient,
} from "./llm.js";
import {
  DEFAULT_MODELS,
  PROVIDERS,
  apiKeyFor,
  inferProvider,
  type Provider,
} from "./models.js";
import { buildRecord, type UndatedCompany } from "./record.js";
import { addUtcDays, assignDates } from "./schedule.js";
import { repoRoot, resolveFromRoot } from "./paths.js";
import {
  AbortRunError,
  type Rejection,
  type RejectionReason,
} from "./types.js";
import {
  buildCompaniesFile,
  rejectedPathFor,
  writeCompaniesFile,
  writeRejected,
} from "./write.js";

type Outcome =
  | { ok: true; record: UndatedCompany; lowConfidence: boolean }
  | { ok: false; reason: RejectionReason; harmonicId?: number };

interface ExtractOptions {
  domains: string;
  start: string;
  out: string;
  provider?: string;
  model?: string;
  concurrency: number;
  cache: boolean;
  dryRun: boolean;
}

function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new InvalidArgumentError("must be a positive integer");
  return n;
}

function resolveProvider(requested: string | undefined): Provider {
  if (requested === undefined) return inferProvider(process.env);
  if (!(PROVIDERS as readonly string[]).includes(requested)) {
    throw new Error(
      `unknown --provider "${requested}". Use one of: ${PROVIDERS.join(", ")}`,
    );
  }
  return requested as Provider;
}

function createClients(options: ExtractOptions): {
  harmonic: HarmonicClient;
  llm: LlmClient;
  provider: Provider;
} {
  const provider = resolveProvider(options.provider);
  const cacheDir = options.cache ? resolveFromRoot(".cache") : null;

  // `--provider mock` is offline, Harmonic included — unless HARMONIC_BASE_URL points somewhere
  // explicitly (that is the seam the tests use for their fixture server).
  const baseUrl = process.env.HARMONIC_BASE_URL?.trim();
  let harmonic: HarmonicClient;
  if (provider === "mock" && !baseUrl) {
    harmonic = createMockHarmonicClient();
  } else {
    const apiKey = process.env.HARMONIC_API_KEY?.trim();
    if (!apiKey)
      throw new Error(
        "HARMONIC_API_KEY is not set (or use --provider mock for an offline run)",
      );
    harmonic = createHarmonicClient({
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
      cacheDir,
    });
  }

  const llm = createLlmClient({
    provider,
    ...(options.model ? { model: options.model } : {}),
    ...(provider === "mock"
      ? {}
      : { apiKey: apiKeyFor(provider, process.env) }),
    cacheDir,
  });

  return { harmonic, llm, provider };
}

async function processDomain(
  domain: string,
  harmonic: HarmonicClient,
  llm: LlmClient,
): Promise<Outcome> {
  const fetched = await harmonic.fetchCompany(domain);
  if (!fetched.ok) return { ok: false, reason: fetched.reason };

  const facts = toFacts(domain, fetched.body);
  // Checked before the LLM call as well as inside buildRecord: a domain we are going to reject for
  // a missing number should not cost a model call.
  if (facts.headcount === null)
    return {
      ok: false,
      reason: "missing_headcount",
      ...idOf(facts.harmonicId),
    };
  if (facts.totalFundingUsd === null)
    return {
      ok: false,
      reason: "missing_funding_total",
      ...idOf(facts.harmonicId),
    };

  let extraction;
  try {
    extraction = await llm.extract(toEvidence(domain, fetched.body));
  } catch (err) {
    if (err instanceof LlmInvalidOutputError) {
      return {
        ok: false,
        reason: "llm_invalid_output",
        ...idOf(facts.harmonicId),
      };
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
  if (!built.ok)
    return { ok: false, reason: built.reason, ...idOf(facts.harmonicId) };
  return {
    ok: true,
    record: built.record,
    lowConfidence: extraction.confidence === "low",
  };
}

function idOf(harmonicId: number | undefined): { harmonicId?: number } {
  return harmonicId === undefined ? {} : { harmonicId };
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

function relative(file: string): string {
  const rel = path.relative(repoRoot, file);
  return rel && !rel.startsWith("..") ? rel : file;
}

async function runExtract(options: ExtractOptions): Promise<void> {
  const domainsFile = resolveFromRoot(options.domains);
  const outFile = resolveFromRoot(options.out);
  const entries = await readDomainsFile(domainsFile);
  const { harmonic, llm, provider } = createClients(options);

  const model = options.model ?? DEFAULT_MODELS[provider];
  console.log(
    `Extracting ${entries.length} domains with ${provider}/${model}, starting ${options.start}` +
      `${options.cache ? "" : " (cache disabled)"}`,
  );

  const outcomes: (Outcome | undefined)[] = new Array(entries.length);
  const accepted: UndatedCompany[] = [];
  const rejected: Rejection[] = [];
  const domainWidth = Math.max(...entries.map((e) => e.domain.length));
  let cursor = 0;

  // Report in input order even though the work finishes out of order.
  function drain(): void {
    while (cursor < outcomes.length) {
      const outcome = outcomes[cursor];
      if (outcome === undefined) return;
      const domain = entries[cursor]!.domain.padEnd(domainWidth);
      if (outcome.ok) {
        // `accepted.length` is the index this record is about to get, which is exactly the
        // arithmetic `assignDates` will do at the end.
        const date = addUtcDays(options.start, accepted.length);
        accepted.push(outcome.record);
        const flag = outcome.lowConfidence ? "  ⚠ low confidence" : "";
        console.log(
          `✔ ${domain}  → ${date}  ${outcome.record.name.padEnd(16)} ${describe(outcome.record)}${flag}`,
        );
      } else {
        rejected.push({
          domain: entries[cursor]!.domain,
          reason: outcome.reason,
          ...idOf(outcome.harmonicId),
        });
        console.log(`✘ ${domain}  rejected: ${outcome.reason}`);
      }
      cursor++;
    }
  }

  let next = 0;
  const workers = Array.from(
    { length: Math.min(options.concurrency, entries.length) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= entries.length) return;
        outcomes[i] = await processDomain(entries[i]!.domain, harmonic, llm);
        drain();
      }
    },
  );
  await Promise.all(workers);

  const rejectedFile = rejectedPathFor(outFile);
  await writeRejected(rejectedFile, rejected);

  if (accepted.length === 0) {
    throw new Error(
      `every domain was rejected — see ${relative(rejectedFile)}`,
    );
  }

  const companies = assignDates(accepted, options.start) as Company[];
  const file = buildCompaniesFile(
    companies,
    options.start,
    new Date().toISOString(),
  );
  const span = `${companies[0]!.date} → ${companies[companies.length - 1]!.date}`;

  if (options.dryRun) {
    console.log(
      `Dry run: ${companies.length} companies (${span}) not written. ${rejected.length} rejected → ${relative(rejectedFile)}`,
    );
  } else {
    await writeCompaniesFile(outFile, file);
    console.log(
      `Wrote ${companies.length} companies to ${relative(outFile)} (${span}). ` +
        `${rejected.length} rejected → ${relative(rejectedFile)}`,
    );
  }
  if (rejected.length > 0) {
    console.log(
      "⚠ Rejections shift the schedule. Fix or remove them in domains.txt and re-run (cache makes it cheap).",
    );
  }
}

async function runValidate(file: string): Promise<void> {
  const resolved = resolveFromRoot(file);
  const parsed = CompaniesFileSchema.safeParse(
    JSON.parse(await readFile(resolved, "utf8")),
  );
  if (!parsed.success) {
    console.error(`✘ ${relative(resolved)} is not a valid companies file:`);
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }
  const { companies } = parsed.data;
  console.log(
    `✔ ${relative(resolved)}: ${companies.length} companies, ` +
      `${companies[0]!.date} → ${companies[companies.length - 1]!.date}`,
  );
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("extract")
    .description(
      "Turn a list of domains into data/companies.json (Harmonic numbers + LLM categories)",
    )
    .option("-d, --domains <file>", "domains file, one per line")
    .option("-s, --start <date>", "first puzzle date, YYYY-MM-DD (UTC)")
    .option("-o, --out <file>", "output file", "data/companies.json")
    .option(
      "--provider <name>",
      `${PROVIDERS.join(" | ")} (default: inferred from the API key that is set)`,
    )
    .option("--model <id>", "override the provider's default model")
    .option(
      "--concurrency <n>",
      "domains in flight at once",
      parsePositiveInt,
      3,
    )
    .option("--no-cache", "ignore .cache/ and refetch everything")
    .option("--dry-run", "fetch and extract but do not write --out", false)
    .action(async (options: ExtractOptions) => {
      if (!options.domains) throw new Error("--domains is required");
      if (!options.start) throw new Error("--start is required");
      await runExtract(options);
    });

  program
    .command("validate <file>")
    .description("zod-validate an existing companies file")
    .action(runValidate);

  return program;
}

async function main(): Promise<void> {
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (err) {
    if (err instanceof AbortRunError) {
      console.error(`\n✘ ${err.message}`);
      process.exit(err.exitCode);
    }
    console.error(`\n✘ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

await main();
