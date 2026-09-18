/**
 * Reads `domains.txt`. The domain becomes the company id forever (`id === domain`), so
 * normalisation is strict and a duplicate is an error rather than a warning.
 */
import { readFile } from "node:fs/promises";

export interface DomainEntry {
  /** the line as written, for error messages */
  raw: string;
  domain: string;
  /** 1-based */
  line: number;
}

const DOMAIN_RE =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * `https://www.n26.com/about?x=1  # comment` → `n26.com`. Returns null for a blank or
 * comment-only line; the result is not necessarily a valid domain — `isDomain` decides that.
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

export function parseDomainsFile(contents: string): DomainEntry[] {
  const entries: DomainEntry[] = [];
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
    entries.push({ raw: raw.trim(), domain, line });
  });

  if (entries.length === 0) throw new Error("no domains found");
  return entries;
}

export async function readDomainsFile(file: string): Promise<DomainEntry[]> {
  const contents = await readFile(file, "utf8");
  try {
    return parseDomainsFile(contents);
  } catch (err) {
    throw new Error(`${file}: ${(err as Error).message}`);
  }
}
