/**
 * SERVER-ONLY entry point (`@venturedle/shared/server`). The backend and the extractor import from
 * here; the SPA must not. Everything the client entry exports is re-exported, plus `Company`, the
 * zod schemas and the scoring functions.
 */
export * from "./index.js";

export type { CompaniesFile, Company, CompanySource } from "./company.js";
export {
  CompaniesFileSchema,
  CompanySchema,
  CompanySourceSchema,
  isCalendarDate,
  parseCompaniesFile,
  toCompanyLite,
} from "./company.js";

export { buildShareText, evaluateGuess, formatElapsed } from "./scoring.js";
