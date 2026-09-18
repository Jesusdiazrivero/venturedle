/**
 * CLIENT-SAFE entry point (`@venturedle/shared`). The SPA imports only from here.
 *
 * `Company` — the record with the answer-revealing fields — is deliberately absent: it lives in
 * `@venturedle/shared/server`, which `frontend/` never imports. That structural split is what
 * enforces invariant 1 in CLAUDE.md; there is no lint rule behind it.
 */
export {
  BUSINESS_MODELS,
  FUNDING_BUCKETS,
  FUNDING_STAGES,
  HEADCOUNT_BUCKETS,
  SECTORS,
  bucketOf,
} from "./enums.js";
export type { Bucket, BusinessModel, FundingStage, Sector } from "./enums.js";

export { REGIONS, REGION_BY_COUNTRY, regionOf } from "./regions.js";
export type { Region } from "./regions.js";

export { COLUMN_DEFS } from "./columns.js";

export type { CompanyLite } from "./company.js";

export { API_ERROR_CODES } from "./api.js";
export type {
  ApiError,
  ApiErrorCode,
  AppConfig,
  AuthProvider,
  AuthResponse,
  CellFeedback,
  ColumnDef,
  ColumnKey,
  Direction,
  FeedbackColor,
  GuessResult,
  HealthResponse,
  Leaderboard,
  LeaderboardRow,
  PlayState,
  Player,
  PuzzleInfo,
} from "./api.js";
