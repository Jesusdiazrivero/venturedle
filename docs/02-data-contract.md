# 02 — Data contract (`shared/` and `companies.json`)

`shared/` is the single source of truth for every type that crosses a component boundary. It has
**no runtime dependencies except `zod`** and **no build step**: its `package.json` exports
`./src/index.ts` and the other workspaces import it as TypeScript source through the npm workspace
symlink (`@venturedle/shared`). Vite compiles it into the frontend bundle; the backend runs under
`tsx` (dev and prod alike) and so consumes it directly; `tsc --noEmit` type-checks it. This is
what avoids v1's "path alias in three places" problem. Keep it small; if a thing is only used by
one component, it does not belong here.

```
shared/
  package.json          # name: @venturedle/shared, "type": "module"
                        # exports: { ".": "./src/index.ts", "./server": "./src/server.ts" }
  src/
    index.ts            # CLIENT-SAFE: enums, regions, COLUMN_DEFS, CompanyLite, api DTOs
    server.ts           # SERVER-ONLY: re-exports index + Company, zod schemas, evaluateGuess, buildShareText
    enums.ts            # FUNDING_STAGES, BUSINESS_MODELS, SECTORS, buckets, bucketOf()
    regions.ts          # REGION_BY_COUNTRY, regionOf()
    company.ts          # Company, CompanyLite, CompaniesFile + zod schemas
    scoring.ts          # evaluateGuess(), buildShareText()
    columns.ts          # COLUMN_DEFS (needed by the SPA to render the grid header)
    api.ts              # request/response DTOs for the HTTP API
  test/
    scoring.test.ts     # port + extend v1's 33 tests (vitest)
```

Two entry points instead of a lint rule: `frontend/` imports only `@venturedle/shared`;
`backend/` and `extractor/` import `@venturedle/shared/server`. `Company` (with the answer-
revealing fields) is simply not exported from the client entry, so the SPA cannot see it by
construction. No ESLint needed for this.

## `companies.json`

The extractor writes it; the backend reads it. Nothing else touches it. Human-readable on purpose:
operators will open it in an editor to fix a sector or swap a date.

```jsonc
{
  "version": 1,
  "generatedAt": "2026-09-18T10:12:33Z",
  "startDate": "2026-10-01",
  "companies": [
    {
      "id": "klarna.com", // == domain, lowercase, no scheme/www. Stable forever.
      "date": "2026-10-01", // the UTC date this company is the answer
      "domain": "klarna.com",
      "name": "Klarna",
      "logoUrl": "https://assets.harmonic.ai/company_....png",
      "sectors": ["Fintech", "Payments"], // 1–3 values from SECTORS
      "businessModel": ["B2C", "B2B2C"], // 1–4 values from BUSINESS_MODELS
      "hqCountry": "SE", // ISO-3166-1 alpha-2, uppercase
      "region": "Europe", // derived: regionOf(hqCountry)
      "foundedYear": 2005,
      "fundingStage": "Public", // one of FUNDING_STAGES
      "totalFundingUsd": 9460186174, // integer USD, from Harmonic, never LLM-invented
      "headcount": 4585, // integer, from Harmonic
      "source": {
        // provenance; backend ignores, humans don't
        "harmonicId": 425798,
        "harmonicFetchedAt": "2026-09-18T10:11:02Z",
        "llm": "anthropic/claude-sonnet-4-5",
        "notes": "stage EXITED resolved to Public via IPO round 2025-09-11",
      },
    },
  ],
}
```

Rules the zod schema (`CompaniesFileSchema`) enforces, and the backend refuses to start without:

- `companies` non-empty; every `id` unique; every `date` unique and a valid `YYYY-MM-DD`.
- `companies` sorted by `date` ascending (the extractor guarantees it; the backend validates it so
  `puzzleNumber` = index + 1 is meaningful).
- `sectors` ⊆ `SECTORS`, `businessModel` ⊆ `BUSINESS_MODELS`, `fundingStage` ∈ `FUNDING_STAGES`.
- `hqCountry` matches `/^[A-Z]{2}$/`; `region` equals `regionOf(hqCountry)`.
- `foundedYear` integer in `[1800, currentYear]`; `totalFundingUsd`, `headcount` non-negative
  integers.
- `logoUrl` is an `https://` URL.

Dates need not be consecutive (an operator may delete a company and leave a gap). `startDate` is
informational.

## Types

```ts
// company.ts
export interface Company {
  id: string;
  date: string;
  domain: string;
  name: string;
  logoUrl: string;
  sectors: Sector[];
  businessModel: BusinessModel[];
  hqCountry: string;
  region: Region;
  foundedYear: number;
  fundingStage: FundingStage;
  totalFundingUsd: number;
  headcount: number;
  source?: {
    harmonicId?: number;
    harmonicFetchedAt?: string;
    llm?: string;
    notes?: string;
  };
}
export type CompanyLite = Pick<Company, "id" | "name" | "logoUrl">; // what the SPA sees
export interface CompaniesFile {
  version: 1;
  generatedAt: string;
  startDate: string;
  companies: Company[];
}
```

`Company` (with the answer-revealing fields) is only ever held by the extractor and the backend.
The frontend imports `CompanyLite` and the API DTOs from the client entry point only (see the
two-entry-point layout above).

## Sector taxonomy

The LLM must pick from this closed list. It is intentionally coarse (~30 values) so that the
"yellow on overlap" rule is meaningful and so different LLMs converge on the same answer. Edit the
list here only; the extractor's prompt and the zod schema both read from it.

```ts
export const SECTORS = [
  "AI / ML",
  "Adtech",
  "Aerospace & Defense",
  "Agtech",
  "Biotech",
  "Climate & Energy",
  "Consumer",
  "Crypto / Web3",
  "Cybersecurity",
  "Data & Analytics",
  "Developer Tools",
  "E-commerce",
  "Edtech",
  "Enterprise Software",
  "Fintech",
  "Food & Beverage",
  "Gaming",
  "Hardware & Robotics",
  "Healthtech",
  "HR & Future of Work",
  "Insurtech",
  "Legal & Govtech",
  "Logistics & Supply Chain",
  "Marketplace",
  "Media & Entertainment",
  "Mobility & Automotive",
  "Payments",
  "Proptech & Construction",
  "SaaS Infrastructure",
  "Social",
  "Travel & Hospitality",
] as const;
```

Two rules to make yellows fair: a company gets **1–3 sectors**, the first being the primary one;
"Payments" implies "Fintech" is _not_ automatically added (the LLM decides), and "Marketplace" as
a sector is about the _product category_, distinct from `businessModel: "Marketplace"`.

## API DTOs (`api.ts`)

Every HTTP response body is one of these. The backend types its handlers against them; the frontend
types its `fetch` wrappers against them. Full endpoint semantics in `04-backend.md`.

```ts
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

export interface AppConfig {
  // GET /api/config
  authMode: "anonymous" | "google";
  googleClientId?: string; // only when authMode === "google"
  googleAllowedDomain?: string; // only when set; lets the SPA word the sign-in hint
}

export interface Player {
  id: string;
  nickname: string;
  provider: "anonymous" | "google";
}
export interface AuthResponse {
  token: string;
  player: Player;
} // POST /api/auth/*

export interface PuzzleInfo {
  // GET /api/puzzle/today
  date: string;
  exists: boolean;
  number?: number;
  nextPuzzleAt: string; // ISO timestamp of next UTC midnight
}
// The SPA renders the grid header from COLUMN_DEFS imported from shared; the API does not send it.

export interface PlayState {
  // GET/POST /api/results/today(...)
  date: string;
  number: number;
  status: "not_started" | "playing" | "solved";
  startedAt?: string;
  solvedAt?: string;
  elapsedMs?: number;
  guesses: GuessResult[];
  answer?: CompanyLite; // only when status === "solved"
  shareText?: string; // only when status === "solved"
}

export interface LeaderboardRow {
  rank: number;
  player: Player;
  isMe: boolean;
  guesses: number;
  elapsedMs: number; // today: exact; all-time: averages (rounded)
  daysSolved?: number; // all-time only
}
export interface Leaderboard {
  scope: "today" | "alltime";
  by: "guesses" | "time";
  date?: string;
  rows: LeaderboardRow[];
  me?: LeaderboardRow;
}

export interface ApiError {
  error: string;
  message?: string;
} // every non-2xx body
```

Error codes used across the API (string `error` values, with HTTP status):

| code                 | status | when                                                                                               |
| -------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| `unauthorized`       | 401    | missing/unknown bearer token on an authenticated route (SPA clears its token)                      |
| `invalid_token`      | 400    | `POST /api/auth/google` with an ID token that fails verification (SPA shows an error, keeps state) |
| `forbidden_domain`   | 403    | Google account outside `GOOGLE_ALLOWED_DOMAIN`                                                     |
| `auth_mode_mismatch` | 400    | calling the auth endpoint of the mode that is not enabled                                          |
| `nickname_invalid`   | 400    |                                                                                                    |
| `invalid_body`       | 400    | zod validation failure                                                                             |
| `unknown_company`    | 400    | `companyId` not in the pool                                                                        |
| `already_guessed`    | 409    | same company twice in one play                                                                     |
| `no_puzzle_today`    | 404    | nothing scheduled for today's UTC date                                                             |
| `not_found`          | 404    |                                                                                                    |
| `rate_limited`       | 429    | auth endpoints                                                                                     |
| `internal`           | 500    |                                                                                                    |

Note there is **no** `already_solved` error: guessing after a solve returns `200` with the
unchanged `PlayState`, so mutation responses are always a `PlayState` and the SPA never has to
special-case it.

## Scoring (`scoring.ts`)

```ts
export const COLUMN_DEFS: ColumnDef[]; // columns.ts — the seven, in order (client-safe)
export function evaluateGuess(
  guess: Company,
  answer: Company,
): { cells: CellFeedback[]; correct: boolean };
export function buildShareText(args: {
  number: number;
  date: string;
  guesses: GuessResult[];
  elapsedMs: number;
  publicUrl?: string;
}): string;
```

Pure functions, no I/O, exhaustively unit-tested per `01-game-rules.md`. `correct` is
`guess.id === answer.id`. The backend wraps `evaluateGuess` output into a `GuessResult` by adding
`seq`, `guess` (as `CompanyLite`) and `at`.
