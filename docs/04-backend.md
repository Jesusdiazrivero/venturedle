# 04 — Backend

The only long-running process. A Hono app on Node 24 (`engines: ">=24"`; `node:sqlite` is
unflagged but still evolving, so pin the major and expect small `db.ts` touches on Node upgrades)
using the built-in `node:sqlite` module — no native compilation, no ORM, no migrations framework. It loads
`companies.json` into memory, evaluates guesses, stores plays and guesses in SQLite, serves
leaderboards and, in production, serves the built frontend from the same origin.

## Why these pieces

- **Hono**: ~14 kB, standard `Request`/`Response`, runs on Node today and on Bun/Deno/Workers with a
  one-line adapter change if someone ever wants that. `app.request()` makes handler tests trivial.
- **`node:sqlite`**: ships with Node; `DatabaseSync` is synchronous, which is fine at this scale and
  makes the code linear. WAL mode on. One file, backed up by copying it. If someone needs Postgres
  later, the SQL is plain enough; see `07-decisions.md`.
- **Companies in memory, not in SQLite**: `companies.json` is the source of truth and is already
  validated; copying it into tables would add a sync problem. The backend re-reads the file when
  its mtime changes (checked at most every 30 s, on request), so replacing the file on the server
  needs no restart.

## Configuration (env)

Relative paths resolve against the **repo root** (`process.env.INIT_CWD ?? process.cwd()`), the
same rule as the extractor, so the defaults below mean the same thing from `npm run dev` at the
root and from `npm run dev -w backend`. In Docker the paths are absolute.

| Var                     | Default                    | Notes                                                                                                               |
| ----------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `PORT`                  | `8080`                     |                                                                                                                     |
| `DATA_DIR`              | `data`                     | holds `venturedle.db` (always `$DATA_DIR/venturedle.db`) and, by default, `companies.json`; a Docker volume in prod |
| `COMPANIES_FILE`        | `$DATA_DIR/companies.json` | `.env.example` points it at `data/companies.example.json` for keyless dev                                           |
| `STATIC_DIR`            | `frontend/dist`            | served at `/` when the directory exists; SPA fallback to `index.html`                                               |
| `AUTH_MODE`             | `anonymous`                | `anonymous` \| `google`                                                                                             |
| `GOOGLE_CLIENT_ID`      | —                          | required when `AUTH_MODE=google`                                                                                    |
| `GOOGLE_ALLOWED_DOMAIN` | —                          | optional; when set, the ID token's `hd` claim must match (Workspace lock)                                           |
| `PUBLIC_URL`            | —                          | appended to share text (e.g. `https://venturedle.example.com`)                                                      |
| `DEV_TODAY`             | unset                      | dev/test only: pin "today" to a `YYYY-MM-DD`. Boot fails if set with `NODE_ENV=production`                          |

That is the whole list. No CORS variable (the Vite dev server proxies `/api`, prod is same-origin),
no log level (one-line stdout logs, always on), no separate database path. Dev scripts load the
root `.env` via Node's `--env-file` flag (through `tsx`); the backend has no `dotenv` dependency;
in production the container gets its environment from compose.

Fail fast at boot: missing/invalid `COMPANIES_FILE`, `AUTH_MODE=google` without a client id, an
unwritable `DATA_DIR`, `DEV_TODAY` in production.

## SQLite schema

Applied idempotently at boot (`CREATE TABLE IF NOT EXISTS …`) from `backend/src/db/schema.sql`. A
`meta(key, value)` table holds `schema_version`; bumping it and adding an `ALTER` block is the whole
migration story.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS players (
  id               TEXT PRIMARY KEY,            -- 'anon:' + 22-char base64url random, or 'google:' + sub
  nickname         TEXT NOT NULL,
  provider         TEXT NOT NULL CHECK (provider IN ('anonymous','google')),
  created_at       TEXT NOT NULL,               -- ISO-8601 UTC
  last_seen_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash       TEXT PRIMARY KEY,            -- sha256(token); the raw token is never stored
  player_id        TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at       TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_player ON sessions(player_id);

CREATE TABLE IF NOT EXISTS plays (
  player_id        TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  date             TEXT NOT NULL,               -- YYYY-MM-DD (UTC)
  puzzle_number    INTEGER NOT NULL,            -- #N at the time of play; never recomputed
  answer_json      TEXT NOT NULL,               -- CompanyLite of the answer, snapshot at start (served only once solved)
  started_at       TEXT NOT NULL,
  solved_at        TEXT,                        -- NULL while playing
  guess_count      INTEGER NOT NULL DEFAULT 0,
  elapsed_ms       INTEGER,                     -- solved_at - started_at, denormalised for leaderboards
  PRIMARY KEY (player_id, date)
);
CREATE INDEX IF NOT EXISTS plays_date_solved ON plays(date, solved_at);

CREATE TABLE IF NOT EXISTS guesses (
  player_id        TEXT NOT NULL,
  date             TEXT NOT NULL,
  seq              INTEGER NOT NULL,            -- 1-based, per play
  company_id       TEXT NOT NULL,               -- guessed company id
  guess_json       TEXT NOT NULL,               -- CompanyLite of the guess, snapshot at guess time
  correct          INTEGER NOT NULL,            -- 0/1
  cells_json       TEXT NOT NULL,               -- CellFeedback[] as computed at the time
  created_at       TEXT NOT NULL,
  PRIMARY KEY (player_id, date, seq),
  UNIQUE (player_id, date, company_id),         -- enforces "one guess per company per play"
  FOREIGN KEY (player_id, date) REFERENCES plays(player_id, date) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
```

Everything needed to rebuild a past `PlayState` is **snapshotted in the play's own rows**
(`puzzle_number`, `answer_json`, `guess_json`, `cells_json`). `buildPlayState` therefore never
consults `CompanyIndex` for historical data: an operator can rename, delete or reorder companies in
`companies.json` and no one's grid, share text or puzzle number changes. `answer_json` is written
at start but only serialised to the client once `solved_at` is set.

## Identity and auth

Both modes end in the same place: a **session token** (32 random bytes, base64url) returned once to
the client and sent as `Authorization: Bearer <token>` on every `/api/*` call except the public
ones. The server stores only `sha256(token)`. Tokens do not expire (a game, not a bank); `DELETE
/api/auth/session` revokes one.

- **anonymous**: `POST /api/auth/anonymous { nickname }` creates a player + session. No password,
  no recovery. The SPA keeps the token in `localStorage`; a new browser is a new player.
- **google**: the SPA obtains a Google ID token with Google Identity Services and calls
  `POST /api/auth/google { idToken }`. The backend verifies it with `google-auth-library`
  (`verifyIdToken`, audience = `GOOGLE_CLIENT_ID`), enforces `GOOGLE_ALLOWED_DOMAIN` against the
  `hd` claim if set (`403 forbidden_domain`), upserts the player as `google:<sub>` with nickname =
  Google `name` (or email local-part) on first sight, and issues a session. Later sign-ins on other
  devices resolve to the same player.
- Calling the endpoint for the mode that is not enabled → `400 auth_mode_mismatch`. An ID token
  that fails verification → `400 invalid_token` (not 401, so the SPA does not treat it as an
  expired session).
- `PATCH /api/me { nickname }` works in both modes (2–24 chars after trim, no control chars;
  `nickname_invalid` otherwise).

A single Hono middleware resolves the bearer token to `c.get("player")` and bumps `last_seen_at`
(throttled to once a minute per session to avoid write amplification).

## Endpoints

All under `/api`. JSON in, JSON out. Error bodies are `{ error, message? }` (see `02-data-contract.md`).

### Public

| Method | Path                  | Response         | Notes                                                                                                                                   |
| ------ | --------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/health`         | `HealthResponse` | for the Docker healthcheck                                                                                                              |
| GET    | `/api/config`         | `AppConfig`      | tells the SPA which auth mode to render                                                                                                 |
| GET    | `/api/companies`      | `CompanyLite[]`  | the guess pool, sorted by name; `Cache-Control: public, max-age=300`                                                                    |
| GET    | `/api/puzzle/today`   | `PuzzleInfo`     | `exists:false` when no company is scheduled for today's UTC date                                                                        |
| POST   | `/api/auth/anonymous` | `AuthResponse`   | body `{ nickname }`                                                                                                                     |
| POST   | `/api/auth/google`    | `AuthResponse`   | body `{ idToken }`                                                                                                                      |
| GET    | `/api/leaderboard`    | `Leaderboard`    | query `scope=today\|alltime` (default today), `by=guesses\|time` (default guesses). Auth optional: when present, `me`/`isMe` are filled |

### Authenticated (bearer)

| Method | Path                         | Response    | Notes                                                                                      |
| ------ | ---------------------------- | ----------- | ------------------------------------------------------------------------------------------ |
| GET    | `/api/me`                    | `Player`    |                                                                                            |
| PATCH  | `/api/me`                    | `Player`    | body `{ nickname }`                                                                        |
| DELETE | `/api/auth/session`          | `204`       | sign out this device                                                                       |
| GET    | `/api/results/today`         | `PlayState` | `status:"not_started"` if no play row yet; `404 no_puzzle_today` if nothing scheduled      |
| POST   | `/api/results/today/start`   | `PlayState` | idempotent: creates the play with `started_at = now` if absent, else returns current state |
| POST   | `/api/results/today/guesses` | `PlayState` | body `{ companyId }`. Appends a guess and returns the full updated state                   |

`"today"` is always the server's UTC date. There is deliberately no `?date=` parameter in v2 —
past puzzles are not replayable and future ones must not leak. Leaderboards for past dates are a
one-line addition (`scope=date&date=YYYY-MM-DD`) if ever wanted.

### Guess handling (the core transaction)

```
POST /api/results/today/guesses
  1. today = utcDate(now); { company: answer, number } = companies.byDate(today) → 404 no_puzzle_today
  2. guess = companies.byId(body.companyId)                 → 400 unknown_company
  3. BEGIN IMMEDIATE
  4. play = plays[player, today] ?? insert(puzzle_number = number, answer_json = lite(answer), started_at = now)
                                                            (auto-start; clock starts now)
  5. if play.solved_at → COMMIT and return current state unchanged (200; no new row)
  6. if guesses has (player, today, guess.id) → 409 already_guessed   (also enforced by the UNIQUE constraint)
  7. { cells, correct } = evaluateGuess(guess, answer)
  8. insert guesses(seq = play.guess_count + 1, guess_json = lite(guess), correct, cells_json)
  9. update plays set guess_count = seq, solved_at = correct ? now : NULL, elapsed_ms = correct ? now - started_at : NULL
 10. COMMIT
 11. return buildPlayState(player, today)   // includes answer + shareText when solved
```

The answer used for scoring is always **today's company from the live index** (step 1), while the
`answer_json` snapshot is only for rendering history. If an operator swaps today's company mid-day,
players who already started keep their snapshot for display but new guesses are scored against the
new company — an edge case worth a comment in `play.ts`, not code.

`buildPlayState` assembles `PlayState` from `plays` + `guesses` (parsing the `*_json` columns),
adds `answer` and `shareText` only when solved. The `Company` object for the answer is never
serialised; only its `CompanyLite`, and only after the win.

### Leaderboards

Today, by guesses (by time swaps the first two ORDER BY terms):

```sql
SELECT p.id, p.nickname, p.provider, pl.guess_count, pl.elapsed_ms, pl.solved_at
FROM plays pl JOIN players p ON p.id = pl.player_id
WHERE pl.date = ? AND pl.solved_at IS NOT NULL
ORDER BY pl.guess_count ASC, pl.elapsed_ms ASC, pl.solved_at ASC
LIMIT 50;
```

All-time, by guesses (by time: `ORDER BY avg_ms ASC, days DESC`):

```sql
SELECT p.id, p.nickname, p.provider,
       COUNT(*) AS days, AVG(pl.guess_count) AS avg_guesses, AVG(pl.elapsed_ms) AS avg_ms
FROM plays pl JOIN players p ON p.id = pl.player_id
WHERE pl.solved_at IS NOT NULL
GROUP BY p.id
ORDER BY avg_guesses ASC, days DESC
LIMIT 50;
```

`me`: if the caller is authenticated and not in the top 50, run the same query with a window
function (`RANK() OVER (...)`) filtered to their id. Round averages to 2 decimals for guesses and
to whole ms for time in the DTO (`guesses`, `elapsedMs`). Leaderboards are cheap at this scale; no
caching in v2.

## Companies loader

```ts
class CompanyIndex {
  static load(file: string): CompanyIndex; // read → CompaniesFileSchema.parse → index by id and by date
  byId(id): Company | undefined;
  byDate(date): { company: Company; number: number } | undefined;
  lite(): CompanyLite[]; // sorted by name, memoised
  maybeReload(): void; // stat() at most every 30 s; reload if mtime changed; on parse error keep old index and log
}
```

## Static serving

When `STATIC_DIR` exists: `@hono/node-server/serve-static` for real files (long `Cache-Control`
for hashed assets via `onFound`), then a catch-all that serves `index.html` for any non-`/api`
path. Test this with an **absolute** `STATIC_DIR` (as in Docker) — older `serve-static` versions
mishandled absolute roots. When the directory does not exist (dev), `/` returns a small JSON hint.
The frontend dev server proxies `/api` to `:8080`.

## Code layout

No compile step: the backend runs as `tsx src/server.ts` in dev (`tsx watch`) **and** in the
production image. `tsx` is therefore a regular dependency, not a dev dependency. This keeps
`shared/` source-only and removes a whole class of build/alias problems; the cost is ~10 MB of
esbuild in the image. (`tsc --noEmit` is the type check. Node's native type-stripping is a
possible future replacement — see `07-decisions.md`, D1.)

```
backend/
  package.json          # deps: hono, @hono/node-server, google-auth-library, tsx; zod via shared; dev: vitest, typescript
  src/
    server.ts           # createApp(config) + listen when main
    config.ts           # env → Config, with validation
    db/
      schema.sql
      db.ts             # open(), migrate(), typed query helpers
    companies.ts        # CompanyIndex
    auth/
      middleware.ts     # bearer → player
      anonymous.ts
      google.ts
    routes/
      public.ts         # health, config, companies, puzzle
      auth.ts
      me.ts
      results.ts        # start, guesses, state
      leaderboard.ts
    play.ts             # the guess transaction + buildPlayState
    time.ts             # utcDate(), nextUtcMidnight()
    static.ts
  test/
    helpers.ts          # createApp with :memory: db + fixture companies + fake clock
    auth.test.ts
    results.test.ts     # start idempotency, guess flow, already_guessed, guess-after-solve is a no-op 200, no_puzzle_today, collision case, history survives companies.json edits
    leaderboard.test.ts # tie-breaks, me-outside-top-50
    reload.test.ts      # mtime reload keeps old index on bad file
```

Tests run against `new DatabaseSync(":memory:")` and a fixture `companies.json` with three
companies on three consecutive dates; the clock is injectable (`config.now: () => Date`) so
"today" is deterministic. Use `app.request("/api/…", { headers })` — no ports, no supertest.

## Security posture (proportionate)

- Session tokens hashed at rest; constant-time compare not needed since we look up by hash.
- All request bodies validated with zod; unknown company ids rejected before touching the db.
- Nickname sanitised (trim, length, strip control chars); rendered as text by React, never HTML.
- Hono's `secureHeaders()` with `crossOriginOpenerPolicy: "same-origin-allow-popups"` — the
  default `same-origin` COOP silently breaks the Google Identity Services popup, so this is not
  optional in google mode. `X-Frame-Options: DENY`.
- Simple per-IP token bucket on `POST /api/auth/*` (e.g. 20/min) using an in-memory map. The IP is
  the first `X-Forwarded-For` value when present (Caddy sets it), else the socket address. The app
  only ever sits behind Caddy or on localhost, so the header's spoofability is accepted.
- No PII beyond a nickname (and Google `sub`/name in google mode). No emails stored.
