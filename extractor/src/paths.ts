/**
 * Every path the operator types — `-d data/domains.txt`, `-o data/companies.json` — is relative to
 * where they ran `npm run extract`, not to `extractor/`. npm puts that directory in `INIT_CWD`.
 */
import path from "node:path";

export const repoRoot = process.env.INIT_CWD ?? process.cwd();

export function resolveFromRoot(p: string): string {
  return path.resolve(repoRoot, p);
}
