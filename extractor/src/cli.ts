/**
 * The composition root: flags in, exit code out. It validates the flags, builds the two clients
 * from the environment, and hands both to `extract`. The pipeline itself reads no `process.env`
 * and knows nothing about commander.
 */
import { Command } from "commander";
import { createHarmonicClient } from "./harmonic.js";
import { extract, validate, type Clients } from "./index.js";
import {
  PROVIDERS,
  apiKeyFor,
  createLlmClient,
  inferProvider,
  type Provider,
} from "./llm.js";
import { AbortRunError } from "./tools.js";

interface Flags {
  domains?: string;
  start?: string;
  out: string;
  provider?: string;
  model?: string;
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

async function createClients(flags: Flags): Promise<Clients> {
  const provider = resolveProvider(flags.provider);

  const apiKey = process.env.HARMONIC_API_KEY?.trim();
  if (!apiKey) throw new Error("HARMONIC_API_KEY is not set");
  const baseUrl = process.env.HARMONIC_BASE_URL?.trim();

  return {
    harmonic: createHarmonicClient({ apiKey, ...(baseUrl ? { baseUrl } : {}) }),
    llm: await createLlmClient({
      provider,
      ...(flags.model ? { model: flags.model } : {}),
      apiKey: apiKeyFor(provider, process.env),
    }),
  };
}

const program = new Command();

program
  .name("extract")
  .description(
    "Turn a list of domains into data/companies.json (Harmonic numbers, LLM categories)",
  )
  .option("-d, --domains <file>", "domains file, one per line")
  .option("-s, --start <date>", "first puzzle date, YYYY-MM-DD (UTC)")
  .option("-o, --out <file>", "output file", "data/companies.json")
  .option("--provider <name>", PROVIDERS.join(" | "))
  .option("--model <id>", "override the provider's default model")
  .action(async (flags: Flags) => {
    if (!flags.domains) throw new Error("--domains is required");
    if (!flags.start) throw new Error("--start is required");
    await extract(
      { domains: flags.domains, start: flags.start, out: flags.out },
      await createClients(flags),
    );
  });

program
  .command("validate <file>")
  .description("zod-validate an existing companies file")
  .action(validate);

try {
  await program.parseAsync(process.argv);
} catch (err) {
  console.error(`\n✘ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(err instanceof AbortRunError ? err.exitCode : 1);
}
