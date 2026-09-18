/**
 * `npm run extract` — flags in, exit code out. Everything else is in `index.ts`.
 */
import { Command } from "commander";
import { extract, validate, type ExtractOptions } from "./index.js";
import { PROVIDERS } from "./llm.js";
import { AbortRunError } from "./tools.js";

const program = new Command();

program
  .name("extract")
  .description(
    "Turn a list of domains into data/companies.json (Harmonic numbers, LLM categories)",
  )
  .option("-d, --domains <file>", "domains file, one per line")
  .option("-s, --start <date>", "first puzzle date, YYYY-MM-DD (UTC)")
  .option("-o, --out <file>", "output file", "data/companies.json")
  .option("--provider <name>", PROVIDERS.join(" | "), undefined)
  .option("--model <id>", "override the provider's default model")
  .action((options: ExtractOptions) => extract(options));

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
