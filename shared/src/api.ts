/**
 * Every HTTP request and response body that crosses the wire. Client-safe: nothing here reveals an
 * unsolved answer. Endpoint semantics live in `docs/04-backend.md`.
 */
import type { CompanyLite } from "./company.js";

export type FeedbackColor = "green" | "yellow" | "grey";
export type Direction = "higher" | "lower";
export type ColumnKey =
  | "sectors"
  | "hqCountry"
  | "foundedYear"
  | "fundingStage"
  | "totalFundingUsd"
  | "headcount"
  | "businessModel";

export interface ColumnDef {
  key: ColumnKey;
  label: string;
  kind: "set" | "country" | "year" | "ordinal" | "bucketed";
}

export interface CellFeedback {
  column: ColumnKey;
  color: FeedbackColor;
  direction?: Direction;
  displayValue: string;
}

export interface GuessResult {
  seq: number;
  guess: CompanyLite;
  cells: CellFeedback[];
  correct: boolean;
  at: string;
}

export interface HealthResponse {
  ok: true;
  companies: number;
  today: string;
  uptimeSec: number;
}

/** GET /api/config */
export interface AppConfig {
  authMode: AuthProvider;
  /** only when authMode === "google" */
  googleClientId?: string;
  /** only when set; lets the SPA word the sign-in hint */
  googleAllowedDomain?: string;
}

export type AuthProvider = "anonymous" | "google";

export interface Player {
  id: string;
  nickname: string;
  provider: AuthProvider;
}

/** POST /api/auth/anonymous, POST /api/auth/google */
export interface AuthResponse {
  token: string;
  player: Player;
}

/** GET /api/puzzle/today */
export interface PuzzleInfo {
  date: string;
  exists: boolean;
  number?: number;
  /** ISO timestamp of the next UTC midnight */
  nextPuzzleAt: string;
}

/** GET /api/results/today, POST /api/results/today/start, POST /api/results/today/guesses */
export interface PlayState {
  date: string;
  number: number;
  status: "not_started" | "playing" | "solved";
  startedAt?: string;
  solvedAt?: string;
  elapsedMs?: number;
  guesses: GuessResult[];
  /** only when status === "solved" */
  answer?: CompanyLite;
  /** only when status === "solved" */
  shareText?: string;
}

export interface LeaderboardRow {
  rank: number;
  player: Player;
  isMe: boolean;
  /** today: exact; all-time: the average, rounded */
  guesses: number;
  /** today: exact; all-time: the average, rounded */
  elapsedMs: number;
  /** all-time only */
  daysSolved?: number;
}

export interface Leaderboard {
  scope: "today" | "alltime";
  by: "guesses" | "time";
  date?: string;
  rows: LeaderboardRow[];
  me?: LeaderboardRow;
}

/** Every non-2xx body. Codes are tabulated in `docs/02-data-contract.md`. */
export interface ApiError {
  error: ApiErrorCode | string;
  message?: string;
}

export const API_ERROR_CODES = [
  "unauthorized",
  "invalid_token",
  "forbidden_domain",
  "auth_mode_mismatch",
  "nickname_invalid",
  "invalid_body",
  "unknown_company",
  "already_guessed",
  "no_puzzle_today",
  "not_found",
  "rate_limited",
  "internal",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
