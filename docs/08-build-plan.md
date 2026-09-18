# 08 — Build plan

Phased so each step leaves the repo runnable and tested. Do them in order; do not start a phase
until the previous one's acceptance checks pass. Commit at the end of each phase with the phase
name in the message. Keep the component docs open while working on that component — they are the
spec; this file is only the order of operations.

Conventions for the whole build: TypeScript `strict`, ESM everywhere (`"type": "module"`), Node 24
in `.nvmrc` and `engines: ">=24"`, vitest for tests, Prettier defaults, **no ESLint** (the one
rule it would have enforced — `Company` never reaching the SPA — is done structurally by
`shared`'s two entry points). Root scripts: `dev`, `build`, `test`, `typecheck`, `extract`,
`format`. All relative paths (CLI args, env) resolve against the repo root via `INIT_CWD`.

---

## Phase 0 — Scaffold

Create the workspace skeleton so every later phase drops into place.

- Root `package.json` with workspaces `shared`, `extractor`, `backend`, `frontend`; root scripts
  wired to `-w` targets (`dev` uses `concurrently` to run backend + frontend; `build` =
  `typecheck` + `vite build`; there is no backend or shared compile step — see D1).
- `shared/package.json` with `"exports": { ".": "./src/index.ts", "./server": "./src/server.ts" }`;
  backend and extractor scripts use `tsx` (a regular dependency in `backend/`), dev scripts pass
  `--env-file` for the root `.env`.
- `tsconfig.base.json` (`strict`, `module: NodeNext`, `target: ES2022`, `noEmit`), per-workspace
  `tsconfig.json` extending it; `typecheck` runs `tsc -p` in each workspace.
- `.gitignore` (`node_modules`, `dist`, `.env`, `deploy/.env`, `data/venturedle.db*`,
  `data/rejected.json`), `.nvmrc`, `.env.example` + `deploy/.env.example` (documented in
  `03`/`04`/`06`), `.dockerignore`.
- `CLAUDE.md` (from these docs), `README.md` stub, `LICENSE` (MIT), `docs/` copied in.
- GitHub Actions `ci.yml`: `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, plus
  `docker build .` on main.

**Accept:** `npm install && npm run typecheck && npm test` succeed on an empty workspace set (each
workspace has a placeholder test).

---

## Phase 1 — `shared/`

- `enums.ts`, `regions.ts`, `company.ts` (types + zod `CompanySchema`, `CompaniesFileSchema` with
  the cross-record checks: unique ids/dates, sorted by date, `region === regionOf(hqCountry)`).
- `scoring.ts`: `COLUMN_DEFS`, `evaluateGuess`, `buildShareText`. Port v1's
  `backend/src/lib/evaluateGuess.ts` and `share.ts`, then apply the v2 changes: `correct` is
  id-equality, disjoint bucket edges, share text format from `01-game-rules.md`.
- `api.ts` DTOs exactly as in `02-data-contract.md`.
- Tests: port v1's 33 scoring tests, add: all-green-but-different-id → `correct:false`; bucket
  edge values (999,999 / 1,000,000 / 1,000,000,000); stage adjacency at both ends of the list;
  `regionOf` unknown → `"Other"`; `CompaniesFileSchema` rejects duplicate date, unsorted dates,
  wrong region, unknown sector; share text with 1 guess and with > 1 h elapsed.
- `data/companies.example.json`: ~30 well-known companies hand-written to the schema, scheduled
  daily from `2026-01-01`. Must pass `CompaniesFileSchema`. (It is fine to write this by hand or
  with the mock extractor; note in `source.notes` that values are approximate.)

**Accept:** `npm test -w shared` green; example file validates; `import { Company } from
"@venturedle/shared"` is a type error (only `@venturedle/shared/server` exports it).

---

## Phase 2 — `extractor/`

Five files, per D13 — `cli.ts`, `index.ts`, `harmonic.ts`, `llm.ts`, `tools.ts` — and no cache.

- `tools.ts`: domain normalise/dedupe (tests with messy input), `assignDates` (tests: gaps never
  produced; rejected domains skipped), `buildRecord`, `mapPool`, the writers.
- `harmonic.ts` with `HARMONIC_BASE_URL` override, retries/backoff, abort-on-401/403, and the
  offline `mock` path (deterministic fake company from the domain). Test against an in-process
  fixture server. Record 3–4 real responses into `test/fixtures/harmonic/` on the first real run
  (strip `employees`, `investors`, emails) — until then, use hand-written fixtures in the
  snake_case shape from `03-extractor.md` and mark them `"_fixture": "unverified"`. Tolerant field
  picking lives here too (tests: snake_case and camelCase inputs produce the same evidence;
  `tags_v2` as strings and as objects).
- `llm.ts`: provider factory (anthropic/openai/gemini via LangChain.js chat models, plus `mock`),
  `withStructuredOutput(ExtractionSchema)`, one schema-failure retry. Test with `mock` only.
- `cli.ts` with commander: `extract` (default) and `validate`; `index.ts` has the pretty per-domain
  log lines and the final summary/rejection warning exactly as in `03`.
- E2E test: fixture Harmonic server + mock LLM + a 5-domain file (one 404, one missing headcount)
  → 3 records dated `start`, `start+1`, `start+2`; `rejected.json` has 2 entries; a second run
  reproduces the same schedule.

**Accept:** `npm run extract -- -d extractor/test/fixtures/domains.txt -s 2026-10-01 --provider
mock -o /tmp/out.json` works from the repo root with no keys and no network; output validates; a real run with
`HARMONIC_API_KEY` + one LLM key on 3 domains produces sensible records (manual check — this is
also when the Harmonic field names get verified and fixtures recorded).

---

## Phase 3 — `backend/`

- `config.ts` (env parsing, fail-fast rules incl. `DEV_TODAY` vs production), `time.ts`.
- `db/schema.sql`, `db/db.ts` (`open(path | ":memory:")`, `migrate()`, `run/get/all` helpers).
- `companies.ts` `CompanyIndex` with mtime reload.
- `auth/`: middleware, anonymous, google (google-auth-library; in tests inject a fake verifier).
- `routes/`: public, auth, me, results, leaderboard. `play.ts` transaction. `static.ts`.
- `server.ts`: `createApp(config)` returning the Hono app; `listen` only when run as main.
- Tests per `04-backend.md` (`test/` list). Key cases: start idempotent (same `startedAt` on second
  call); guess flow to solve with `answer` + `shareText` appearing only at the end; `already_guessed`;
  guess after solve returns 200 with the unchanged state; `no_puzzle_today` when `DEV_TODAY` is
  off-schedule; collision company (identical seven-tuple, different id) → all green,
  `correct:false`; history survives renaming/deleting a company in the file (snapshots); leaderboard
  tie-breaks; `me` outside top 50; reload keeps old index when the new file is invalid; google mode
  rejects wrong `hd` (403) and a bad token (400); rate limit on `/api/auth/*` (429); COOP header is
  `same-origin-allow-popups`.

**Accept:** `npm test -w backend` green; `npm run dev -w backend` serves `/api/health` and
`/api/puzzle/today` against the example file with `DEV_TODAY=2026-01-01`; a `curl` script in
`backend/scripts/smoke.sh` creates an anonymous player, starts, guesses wrong, guesses right, and
prints the share text.

---

## Phase 4 — `frontend/`

- `api.ts`, `session.ts`, hooks, `App.tsx` with config load + hash router.
- Views and components per `05-frontend.md`. Port v1's `styles.css`, `GuessGrid`, `CompanyPicker`
  and `WinPanel` and adapt to the new DTOs (`PlayState` replaces `DailyState`; `correct` replaces
  `win`).
- Google button component (loads GIS script lazily; no-op in anonymous mode).
- Tests per `05` with mocked `fetch`.

**Accept:** `npm run dev` from the root gives a playable game at `http://localhost:5173` with no
keys; reload mid-game restores the grid and the running clock; solving shows the answer, share text
copies; leaderboard shows the player; `npm run build -w frontend` output is served by the backend
at `http://localhost:8080` when `STATIC_DIR` points to it.

---

## Phase 5 — Docker, compose, GCP

- `Dockerfile`, `.dockerignore`, `deploy/docker-compose.yml`, `deploy/Caddyfile`,
  `deploy/.env.example`, `deploy/gcp/{create-vm,startup,deploy}.sh` per `06-deployment.md`.
- `README.md` written for a stranger: what it is (with a screenshot), 60-second local run, how to
  generate your own schedule (keys, cost), how to deploy to GCP, how to turn on Google sign-in,
  how to back up. Link to `docs/`.

**Accept:** `docker build .` < 250 MB uncompressed and the container starts with no network; after
`npm run extract -- --provider mock -d extractor/test/fixtures/domains.txt -s "$(date -u +%F)"`,
`cd deploy && DOMAIN=:80 docker compose up -d --build` then `curl localhost/api/health` OK and the
game plays in a browser; replacing `data/companies.json` on the host is picked up without restart;
`create-vm.sh` + `deploy.sh` executed once for real against a GCP project (document the exact
commands that were run and their output in the PR, including how long the on-VM build took).

---

## Phase 6 — Polish (only after 0–5 are done)

- Playwright smoke test against compose (create player → solve → assert share text).
- Countdown-triggered rollover refetch, flag-emoji fallback, picker keyboard nav, `aria-labels`.
- `npm run extract -- validate` wired into CI for `data/companies.example.json`.
- (Deliberately no streaks, hints or extra modes — see `07-decisions.md`.)

**Accept:** CI green; a fresh clone by someone who has never seen the repo reaches a playable local
game in under five minutes following only `README.md`.

---

## Definition of done for v2

Someone with a Harmonic key and one LLM key can: clone, `npm install`, write 30 domains in a file,
run one command, get a `companies.json`, `docker compose up`, point a domain at the box, and share
the link with friends who play under nicknames. Every step is in `README.md`. Nothing requires
reading these docs.
