# CLAUDE.md

Guidance for Claude Code working in this repository. The design lives in `docs/` — this file is the
short version plus the rules that must not be broken. When code and `docs/` disagree, the docs
win until a decision is recorded in `docs/07-decisions.md`.

## What this is

Venturedle: an open-source daily startup-guessing game (Wordle-style). One secret company per UTC
day; guesses are scored across seven columns; leaderboards by guesses and by time. Anyone with a
Harmonic API key and one LLM key (Anthropic / OpenAI / Gemini) can generate their own schedule and
run it with `docker compose`.

Three components, one shared types package:

| Folder       | What                                                                      | Runs where            |
| ------------ | ------------------------------------------------------------------------- | --------------------- |
| `extractor/` | CLI: domains file + start date → `data/companies.json` via Harmonic + LLM | operator's laptop     |
| `backend/`   | Hono API + SQLite (`node:sqlite`); also serves the built SPA              | the one prod process  |
| `frontend/`  | Vite + React SPA                                                          | browser               |
| `shared/`    | types, enums, sector taxonomy, zod schemas, pure scoring                  | imported by all three |

Read `docs/00-overview.md` first, then the doc for the component you are touching.

## Commands

```bash
npm install                                   # once; Node 24 (see .nvmrc)
npm run dev                                   # backend :8080 + frontend :5173, example data, no keys needed
npm test                                      # vitest, all workspaces
npm run typecheck                             # tsc --noEmit per workspace; no compile step exists for shared/backend; no ESLint
npm run build                                 # typecheck + vite build (frontend/dist). Backend runs via tsx, dev and prod.

npm run extract -- -d data/domains.txt -s 2026-10-01          # needs HARMONIC_API_KEY + one LLM key in .env
npm run extract -- --provider mock -d extractor/test/fixtures/domains.txt -s 2026-10-01 -o /tmp/x.json
npm run extract -- validate data/companies.json

npm test -w backend -- results                # one test file by name
npm run extract -- --provider mock -d extractor/test/fixtures/domains.txt -s "$(date -u +%F)"   # keyless schedule starting today
cd deploy && DOMAIN=:80 docker compose up -d --build           # production-like local run on :80 (needs deploy/.env)
```

Dev defaults come from the root `.env.example` (`AUTH_MODE=anonymous`,
`COMPANIES_FILE=data/companies.example.json`, `DEV_TODAY=2026-01-01` so the example schedule
always has a puzzle). Two env files by design: root `.env` = dev + extractor keys (never
deployed); `deploy/.env` = what the production container sees. All relative paths in env and CLI
args resolve against the repo root (`INIT_CWD`), whatever workspace the script runs in.

## Invariants — do not break these

1. **The answer never leaves the backend before it is found.** `Company` (with the seven fields)
   is exported only from `@venturedle/shared/server`, which `frontend/` never imports. The SPA
   receives `CompanyLite` (id, name, logo) and `CellFeedback` computed server-side.
   `PlayState.answer` is set only when `status === "solved"`.
2. **Numbers come from Harmonic, categories from the LLM.** The extractor never lets an LLM
   produce `totalFundingUsd` or `headcount`. Missing numbers → the domain is rejected. A 401/403
   from either API aborts the run instead of rejecting domains.
3. **`companies.json` is the source of truth for the schedule** — and it is the answer key, so it
   is gitignored; only `companies.example.json` is committed. The backend reads it (and re-reads
   on mtime change); it never writes it, and companies are not copied into SQLite.
   `id === domain`. Dates are UTC and unique; the file is sorted by date.
4. **Stored plays are immutable history.** `plays.puzzle_number`, `plays.answer_json`,
   `guesses.guess_json` and `guesses.cells_json` are snapshots written at play time and never
   recomputed — editing, renaming or deleting companies in `companies.json` must not change
   anyone's past grid, share text or puzzle number. `buildPlayState` never consults the company
   index for history.
5. **Winning is `guess.id === answer.id`**, not "all cells green". Two companies can share a
   seven-tuple.
6. **"Today" is the server's UTC date** (`DEV_TODAY` may pin it outside production). There is no
   `?date=` on play endpoints and never will be for future dates.
7. **Session tokens are stored hashed.** Never log or persist a raw token.
8. **Every scoring rule is in `shared/src/scoring.ts` and is unit-tested.** Changing a rule means
   changing `docs/01-game-rules.md`, the code and the tests together.
9. **No new runtime dependencies without a reason written in `docs/07-decisions.md`.** The
   dependency list is a feature.
10. **Nothing in the image or compose file may be GCP-specific.** GCP glue lives in `deploy/gcp/`.

## Conventions

- TypeScript `strict`, ESM, Node 24. Vitest. Prettier defaults. No default exports.
- HTTP: JSON only; every non-2xx body is `{ error, message? }` with codes from
  `docs/02-data-contract.md`. Every 2xx from a play mutation is a full `PlayState` (a guess after
  a solve is a 200 no-op, not an error). Validate request bodies with zod at the edge.
- Env surface is deliberately tiny (`docs/04-backend.md` has the whole table). Adding a variable
  needs a reason in `07-decisions.md`, same as a dependency.
- SQL lives in `backend/src/db/schema.sql` and in the query helpers; plain SQLite, WAL mode, no ORM.
- Tests never hit the network: Harmonic is a fixture server, the LLM is the `mock` provider,
  Google token verification is injected.
- Logs are one line per event, to stdout. No log framework.
- Env vars are documented in `.env.example` the moment they are introduced.

## Where to look

- Scoring rules and share text: `docs/01-game-rules.md`, `shared/src/scoring.ts`
- `companies.json` shape, enums, API DTOs: `docs/02-data-contract.md`, `shared/src/*`
- Extractor pipeline and Harmonic field mapping: `docs/03-extractor.md`
- Endpoints, schema, auth, leaderboard SQL: `docs/04-backend.md`
- Views and components: `docs/05-frontend.md`
- Docker/compose/GCP: `docs/06-deployment.md`
- Why it is like this: `docs/07-decisions.md`
- What to build next: `docs/08-build-plan.md`

## Working style for this repo

Work phase by phase through `docs/08-build-plan.md`; each phase ends with its acceptance checks
passing and a commit. Prefer deleting to abstracting. If a piece of v1 (`../venturedle`, if
present) is a useful porting reference the docs say so — otherwise do not look at v1; v2 is
deliberately not a refactor of it.
