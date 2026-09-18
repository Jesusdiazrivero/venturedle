# 01 — Game rules

These rules are normative. The scoring section is what `shared/src/scoring.ts` must implement and
what its tests must cover. They are carried over from v1 unchanged, so v1's
`backend/src/lib/evaluateGuess.ts` and `backend/test/evaluateGuess.test.ts` are a direct porting
reference.

## The day

- A "day" is a **UTC calendar date** (`YYYY-MM-DD`). The puzzle changes at 00:00 UTC everywhere.
  No per-user timezones. The frontend shows a countdown to the next UTC midnight.
- Each date has at most one company, fixed in advance by the extractor's schedule
  (`companies.json` → `company.date`). Dates before the first scheduled company, after the last,
  or with a gap have **no puzzle**; the API says so and the frontend shows an empty state. Nothing
  wraps or repeats automatically.
- Puzzle number `#N` is the 1-based index of the company in the schedule (the first scheduled
  company is #1). It is shown in the UI and in the share text.

## A play

- A player has exactly one **play** per date. It is created the first time they open that day's
  puzzle (`POST /api/results/today/start`), which records `startedAt`. The clock for the time
  leaderboard runs from `startedAt` to the timestamp of the winning guess.
- Guesses are **unlimited** in v2. There is no "fail" state; a play is either `playing` or
  `solved`. (A configurable cap is a known seam, see `07-decisions.md`.)
- Each guess is stored **as it happens**, in order, with the computed feedback cells. Reloading the
  page restores the full grid from the server. Yesterday's unsolved play simply stays unsolved.
- A company can be guessed only once per play; the picker hides already-guessed companies.
- The **guess pool** is every company in `companies.json`, regardless of its scheduled date. The
  frontend gets only `id`, `name` and `logoUrl` for the pool.

## The seven columns

Order matters (it is the order of the grid and of the share grid rows):

| #   | Column key        | Label         | Kind     | Green                           | Yellow                                  | Grey (+ arrow)                           |
| --- | ----------------- | ------------- | -------- | ------------------------------- | --------------------------------------- | ---------------------------------------- |
| 1   | `sectors`         | Sector        | set      | same set (order-insensitive)    | at least one shared sector              | no overlap                               |
| 2   | `hqCountry`       | HQ Country    | country  | same ISO-2 country              | different country, same `region`        | different region                         |
| 3   | `foundedYear`     | Founded       | year     | same year                       | —                                       | arrow ↑ if answer is later, ↓ if earlier |
| 4   | `fundingStage`    | Stage         | ordinal  | same stage                      | adjacent stage (±1 in `FUNDING_STAGES`) | ≥2 apart; arrow points toward answer     |
| 5   | `totalFundingUsd` | Total Funding | bucketed | same `FUNDING_BUCKETS` bucket   | —                                       | arrow toward answer's bucket             |
| 6   | `headcount`       | Headcount     | bucketed | same `HEADCOUNT_BUCKETS` bucket | —                                       | arrow toward answer's bucket             |
| 7   | `businessModel`   | Model         | set      | same set                        | at least one shared model               | no overlap                               |

Arrows: `direction: "higher"` means the answer's value is higher than the guessed value (so the
player should guess higher). For `fundingStage` the yellow cell also carries a direction.

A guess **wins** when all seven cells are green. Because two distinct companies can in principle
have identical seven-tuples, the server treats a guess as the win **only if `guess.id ===
answer.id`**; an all-green non-matching guess is displayed as all green but `correct: false`. (v1 used
`cells.every(green)`; v2 tightens this. Tests must cover the collision case.)

## Enumerations and bucket tables

```ts
export const FUNDING_STAGES = [
  "Pre-seed",
  "Seed",
  "Series A",
  "Series B",
  "Series C",
  "Series D+",
  "Public",
  "Acquired",
] as const;

export const BUSINESS_MODELS = ["B2B", "B2C", "B2B2C", "Marketplace"] as const;

export const FUNDING_BUCKETS = [
  // USD, inclusive min, inclusive max
  { index: 0, label: "<$1M", min: 0, max: 1_000_000 - 1 },
  { index: 1, label: "$1M–$5M", min: 1_000_000, max: 5_000_000 - 1 },
  { index: 2, label: "$5M–$25M", min: 5_000_000, max: 25_000_000 - 1 },
  { index: 3, label: "$25M–$100M", min: 25_000_000, max: 100_000_000 - 1 },
  { index: 4, label: "$100M–$500M", min: 100_000_000, max: 500_000_000 - 1 },
  { index: 5, label: "$500M–$1B", min: 500_000_000, max: 1_000_000_000 - 1 },
  { index: 6, label: ">$1B", min: 1_000_000_000, max: Infinity },
];

export const HEADCOUNT_BUCKETS = [
  { index: 0, label: "1–10", min: 0, max: 10 }, // min 0 so a data glitch never falls outside the table
  { index: 1, label: "11–50", min: 11, max: 50 },
  { index: 2, label: "51–200", min: 51, max: 200 },
  { index: 3, label: "201–500", min: 201, max: 500 },
  { index: 4, label: "501–1,000", min: 501, max: 1_000 },
  { index: 5, label: "1,001–5,000", min: 1_001, max: 5_000 },
  { index: 6, label: "5,001+", min: 5_001, max: Infinity },
];
```

Note the bucket boundaries: v1 had overlapping `max`/`min` at the edges (e.g. both `≤1,000,000`
and `≥1,000,000`), which `bucketOf` resolved by first match. v2 makes them disjoint so the table is
unambiguous; behaviour at exactly `1,000,000` is "bucket 1" in both. `bucketOf` must be total over
non-negative integers (every value lands in exactly one bucket); a test asserts this.

Ordinal distance for stages uses the index in `FUNDING_STAGES`. "Public" and "Acquired" sitting at
the end is a deliberate simplification: an "Acquired" guess against a "Public" answer is yellow.

## Regions

`region` is derived from `hqCountry` via a fixed table in `shared/src/regions.ts` (port
`backend/src/providers/regions.ts` from v1 and extend it to cover all ISO-2 codes the taxonomy
might see; unknown → `"Other"`). Region values: `North America`, `South America`, `Europe`,
`Middle East`, `Africa`, `Asia`, `Oceania`, `Other`.

## Display values

Each cell carries a `displayValue` string computed server-side so the frontend never formats
domain data:

- `sectors` / `businessModel`: joined with `", "`.
- `hqCountry`: the ISO-2 code (the frontend may render a flag emoji from it).
- `foundedYear`: the year as a string.
- `fundingStage`: the stage label.
- `totalFundingUsd` / `headcount`: **the bucket label**, never the exact number. Exact numbers stay
  on the server.

## Share text

```
Venturedle #12 · 2026-10-12 · 4 guesses · 02:41
🟩🟨⬜⬜🟩⬜🟨
🟩🟩⬜🟨🟩⬜🟩
🟩🟩🟩🟩🟩🟩🟩
https://<public-url>
```

One row per guess, in guess order, seven emoji per row (`🟩` green, `🟨` yellow, `⬜` grey). Time is
`mm:ss` (or `h:mm:ss` beyond an hour). The URL line is the configured `PUBLIC_URL`, omitted if
unset. Generated on the server, returned in the play state once solved.

## Leaderboards

Only **solved** plays appear. Ties broken as listed.

- **Today by guesses**: fewest guesses, then fastest time, then earliest `solvedAt`.
- **Today by time**: fastest time, then fewest guesses, then earliest `solvedAt`.
- **All-time by guesses**: lowest average guesses over all solved plays, then most solved days.
- **All-time by time**: lowest average time over all solved plays, then most solved days.

All-time boards also show `daysSolved`. The frontend shows the top 50 plus the current player's
row if they are outside it. Anonymous players compete under their nickname; nicknames are not
unique and are shown as-is (trimmed, 2–24 chars). This is an honor-system game.

## Identity modes (summary)

- `anonymous` (default): a player picks a nickname; the backend issues an opaque session token the
  SPA keeps in `localStorage`. Losing the token = a new player.
- `google`: players sign in with Google; the backend verifies the ID token, optionally restricts
  to a Workspace domain, and issues the same kind of session token. Player identity is the Google
  `sub`, so history survives nickname/email changes.

Full details in `04-backend.md`.
