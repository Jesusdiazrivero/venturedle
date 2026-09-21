/**
 * `companies.json` held in memory — it is the source of truth for the schedule and it is already
 * validated, so copying it into SQLite would only create a second copy to keep in sync (D5).
 *
 * Replacing the file on a running server is supported: the mtime is checked at most every 30 s, on
 * request. A file that no longer parses is logged and ignored — the old schedule keeps serving.
 */
import { readFileSync, statSync } from "node:fs";
import {
  CompaniesFileSchema,
  toCompanyLite,
  type CompaniesFile,
  type Company,
  type CompanyLite,
} from "@venturedle/shared/server";

const RELOAD_CHECK_MS = 30_000;

interface Snapshot {
  mtimeMs: number;
  companies: Company[];
  byId: Map<string, Company>;
  /** the puzzle number is the 1-based position in the (date-sorted) file */
  byDate: Map<string, { company: Company; number: number }>;
  lite: CompanyLite[];
}

function read(file: string): Snapshot {
  const mtimeMs = statSync(file).mtimeMs;
  const parsed = CompaniesFileSchema.safeParse(
    JSON.parse(readFileSync(file, "utf8")),
  );
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`${file} is not a valid companies file — ${issues}`);
  }

  const { companies } = parsed.data as CompaniesFile;
  return {
    mtimeMs,
    companies,
    byId: new Map(companies.map((c) => [c.id, c])),
    byDate: new Map(
      companies.map((c, i) => [c.date, { company: c, number: i + 1 }]),
    ),
    lite: companies
      .map(toCompanyLite)
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export class CompanyIndex {
  #snapshot: Snapshot;
  #checkedAtMs = 0;

  private constructor(
    private readonly file: string,
    snapshot: Snapshot,
  ) {
    this.#snapshot = snapshot;
  }

  /** Throws if the file is missing or invalid — the backend must not boot without a schedule. */
  static load(file: string): CompanyIndex {
    return new CompanyIndex(file, read(file));
  }

  byId(id: string): Company | undefined {
    return this.#snapshot.byId.get(id);
  }

  byDate(date: string): { company: Company; number: number } | undefined {
    return this.#snapshot.byDate.get(date);
  }

  /** The guess pool: every scheduled company, past and future, sorted by name (D10). */
  lite(): CompanyLite[] {
    return this.#snapshot.lite;
  }

  count(): number {
    return this.#snapshot.companies.length;
  }

  maybeReload(nowMs: number): void {
    if (nowMs - this.#checkedAtMs < RELOAD_CHECK_MS) return;
    this.#checkedAtMs = nowMs;
    try {
      if (statSync(this.file).mtimeMs === this.#snapshot.mtimeMs) return;
      this.#snapshot = read(this.file);
      console.log(
        `companies reloaded: ${this.#snapshot.companies.length} companies`,
      );
    } catch (err) {
      console.error(
        `companies reload failed, keeping the previous schedule: ${(err as Error).message}`,
      );
    }
  }
}
