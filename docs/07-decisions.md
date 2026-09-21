# 07 — Decisions and seams

Short ADR-style records. Each says what was decided, why, what was rejected, and where the seam is
if the decision needs revisiting. When you are tempted to deviate during implementation, read the
relevant entry first; if you still want to deviate, add a new entry rather than silently changing
course.

---

### D1. TypeScript everywhere, npm workspaces

**Decision.** One language and one toolchain for extractor, backend, frontend and the shared
package. Node ≥ 22.13 (target 24 LTS). No Bun/Deno requirement, no monorepo tooling beyond npm
workspaces.

**Why.** One `npm install`, one set of types crossing every boundary, one CI job. The people who
will fork this are as likely to be TypeScript as Python developers, and the extractor is 300 lines
either way.

**Rejected.** Python extractor + FastAPI (two toolchains for a tiny app); pnpm/turbo (nothing here
is slow enough to need them).

**Corollary — `shared/` is source-only and the backend never compiles.** `shared/package.json`
exports `./src/index.ts`; Vite bundles it into the SPA; the backend and extractor run under
`tsx` in dev and prod; `tsc --noEmit` type-checks. v1 needed the same path alias in three config
files and a Dockerfile that understood the workspace layout — that is the complexity being
removed. Rejected alternatives: building `shared/` to `dist` (adds a watch step to dev and an
ordering constraint to every build); bundling the backend with tsup/esbuild (works, one more tool);
Node 24 native type-stripping (attractive — zero deps — but forbids `enum`/parameter properties
and requires `.ts` import extensions, footguns for a fast-moving build; revisit when it is the
default everywhere).

**Seam.** Components talk only through `companies.json` and HTTP. Someone could rewrite the
extractor in Python against `02-data-contract.md` and nothing else would change.

---

### D2. The extractor is offline and the schedule is a file

**Decision.** Harmonic and the LLM are called only by the CLI, on a laptop. The output is a
committed, human-editable JSON file with one company per date. Production never calls either API.

**Why.** Determinism (everyone gets the same answer, forever), zero runtime cost, reviewable
schedule in a PR, no secrets on the server except an optional Google client id, and the game keeps
working if Harmonic changes its API or the LLM vendor has an outage.

**Rejected.** v1's "pool snapshot + hash(date) mod N" (clever, but changing the pool silently
changes past/future answers and the operator cannot see or curate the order); a nightly sync job in
prod (a cron and two API keys on the server for no benefit).

**Corollary.** `companies.json` is the answer key with dates, so it is gitignored by default and
treated as deploy-time data; only `companies.example.json` is committed. Play history is
snapshotted into SQLite at play time (`puzzle_number`, `answer_json`, `guess_json`, `cells_json`),
so editing the file later never rewrites anyone's grid.

**Seam.** `companies.json` is validated by a zod schema in `shared/`. Any producer that satisfies
it works.

---

### D3. Numbers from Harmonic, categories from the LLM

**Decision.** `totalFundingUsd`, `headcount` and (when present) `foundedYear` are copied verbatim
from Harmonic. The LLM only normalises sectors, business model, country code and funding stage,
and fills `foundedYear` only when Harmonic lacks it. A domain with missing numbers is rejected, not
guessed.

**Why.** LLMs hallucinate numbers confidently; players will notice a wrong headcount bucket and
trust evaporates. Categorical normalisation into a closed taxonomy is where an LLM is reliable and
where rules-based mapping (v1's `tags_v2` pass-through) produced inconsistent, ungueassable
sector sets.

**Seam.** `extractor/src/llm.ts` exposes `extract(evidence) → Extraction`; the schema is the
contract. The provider abstraction is **LangChain.js** (`withStructuredOutput` on a
`BaseChatModel`), chosen over the Vercel AI SDK for the owner's familiarity and the option of
growing the extractor into a multi-step pipeline later; only the model factory and the structured-
output call are used — no chains, templates or agents. Swapping it for raw `fetch` per provider is
contained to that file.

---

### D4. Closed sector taxonomy (~30 values)

**Decision.** The LLM picks 1–3 sectors from a fixed list in `shared/src/enums.ts`.

**Why.** The yellow-on-overlap rule only produces useful information when the vocabulary is
shared across companies. Free-form tags ("BNPL", "Buy Now Pay Later", "Consumer Credit") make
yellows rare and feel random. A closed list also makes different LLM vendors converge.

**Seam.** Edit the list; re-run the extractor (the LLM cache key includes the schema, so it
invalidates itself). Existing `companies.json` files with retired sectors fail validation loudly.

---

### D5. Hono + `node:sqlite`, companies held in memory

**Decision.** Backend on Hono with the built-in SQLite driver. `companies.json` is read into an
in-memory index and reloaded on mtime change. Plays, guesses, players and sessions live in SQLite.

**Why.** No native module to compile (better-sqlite3 is fine but is the #1 "npm install failed"
report in small projects); no ORM to learn; the whole persistence layer is one `schema.sql` and
~150 lines of typed queries. Hono because it is tiny, standards-based and runtime-portable.

**Rejected.** Fastify + Firestore (v1; GCP-bound and heavier); Express (fine, but Hono's
`app.request()` testing story and Web-standard types are nicer); Prisma/Drizzle (overkill for
four tables); storing companies in SQLite (creates a second source of truth).

**Seam.** All SQL is in `backend/src/db/` and `backend/src/routes/leaderboard.ts`, plain and
Postgres-compatible except `PRAGMA`s and `VACUUM INTO`. A `DATABASE_URL=postgres://…` mode would
mean swapping the driver behind the same `query()` helper and moving a few `?` placeholders to
`$1`. Not planned; noted.

---

### D6. Session tokens for both auth modes; Google is opt-in

**Decision.** `AUTH_MODE=anonymous` (default) issues a token to a nickname; `AUTH_MODE=google`
exchanges a Google ID token for the same kind of session token once. The rest of the API only ever
sees a bearer token.

**Why.** Anyone can deploy the anonymous mode with zero configuration. Teams that want "real"
identities (a Workspace-locked internal game, as at Acurio) flip one env var and set a client id.
Exchanging the ID token once avoids v1's hourly re-auth and keeps `google-auth-library` out of the
hot path.

**Rejected.** Google-only (kills the "anyone can run it" goal); passwords/magic links (a whole
product surface for a game); JWTs (nothing to gain over an opaque token + one indexed lookup).

**Seam.** `backend/src/auth/*.ts`: adding GitHub or Slack OAuth is one new exchange endpoint that
ends in `createSession(playerId)`.

---

### D7. One VM, docker compose, Caddy — GCP first

**Decision.** Production is `docker compose up -d` on a Compute Engine VM with the app container and
a Caddy container. State is the `data/` directory. Backups are a daily disk-snapshot schedule
created by `create-vm.sh`; there is no cron, bucket or backup script.

**Why.** SQLite needs a disk and a single writer; a VM gives both for free (Always Free tier in US
regions) and the compose file is identical on every other cloud. Caddy removes the TLS chore.
Disk snapshots back up the database and the schedule together with zero moving parts; a GCS
pipeline (bucket, lifecycle rule, IAM, scopes, cron) was designed and cut as accidental complexity.

**Rejected.** Cloud Run + Litestream (works, but two more concepts — GCS replication, restore-on-
boot, max-instances=1 — for the same outcome); Cloud Run + Cloud SQL (≥ $10/month and a second
service for a hobby-scale game); Firebase Hosting + separate API origin (CORS, two deploys).

**Seam.** The image serves both API and SPA on one port; any container host with a persistent
volume can run it. Horizontal scaling is explicitly out of scope until D5's seam is exercised.

---

### D8. UTC days, unlimited guesses, honor-system leaderboards

**Decision.** The day flips at 00:00 UTC for everyone. Guesses are unlimited. There is no
anti-cheat; nicknames are not unique.

**Why.** Per-user timezones would make "today's leaderboard" incoherent. A guess cap adds a
"failed" state, a share-text variant and UI for something Wordle-likes in this genre mostly don't
do. Anti-cheat is unwinnable against a motivated player and pointless against a friendly one.

**Seam.** `MAX_GUESSES` would be: a config value, a `status: "failed"` branch in `play.ts`, one
frontend panel. Leave it.

---

### D9. Time starts when the puzzle is shown

**Decision.** The clock starts at `POST /api/results/today/start` (fired when the Play view
mounts), not at the first guess, and stops at the winning guess.

**Why.** First-guess start makes one-guess solves take 0 ms and rewards thinking before typing.
"Shown" is the honest moment.

**Seam.** None needed; the timestamps are stored and the definition lives in `play.ts` only.

---

### D10. The guess pool is the whole schedule

**Decision.** `GET /api/companies` returns every company in `companies.json`, including past and
future answers. Only `id`, `name`, `logoUrl`.

**Why.** Simplest thing that works; players need a searchable list and the schedule is the list.
It does mean the answer set is knowable and shrinks over time for an attentive player — the same
was true of v1's pool.

**Seam.** A `pool` array of extra distractor companies in `companies.json` (extracted the same
way, never scheduled) would fix both issues. Straightforward extension of the extractor
(`--pool-domains`) and of `CompanyIndex.lite()`. Not in v2.

---

### D11. No API for past or future dates

**Decision.** Every play/result endpoint is implicitly "today". No `?date=`.

**Why.** Future dates would leak answers; past-date replay needs a second play model and confuses
leaderboards. YAGNI.

**Seam.** Leaderboard by date is trivial (`scope=date&date=`). Replay is not, and is not wanted.

---

### D12. The extractor's dependency list

**Decision.** `extractor/` adds `commander`, `zod`, `tsx` and the four LangChain packages
(`@langchain/core` + one per provider). It does **not** add `dotenv`: `tsx
--env-file-if-exists=../.env` already loads the root `.env`, and Node reads it natively.

**Why.** Invariant 9 asks for a reason per dependency. `commander` is the one that carries the
help text, the `validate` subcommand and `--no-cache` for ~30 lines of code. `zod` is already the
project's schema language (`shared/`), so the LLM's structured output is validated by the same
library that validates the file it ends up in. LangChain is D3's provider seam. `tsx` is how every
non-browser workspace runs (D1). `dotenv` would have been a dependency for a flag we already pass.

**Rejected.** Hand-rolled arg parsing (it grows into a worse commander); the provider SDKs directly
(three structured-output implementations instead of one — see D3); `.env` parsing of our own.

**Seam.** `cli.ts` is the only file that imports `commander`, and `llm.ts` the only one that
imports LangChain — both replaceable in one file.

---

### D13. No cache; five files; five flags

**Decision.** The extractor has no disk cache, no `--no-cache`, no `--dry-run` and no
`--concurrency` (it is fixed at 3). `extractor/src/` is five files: `cli.ts` (flags and exit
code), `index.ts` (the pipeline), `harmonic.ts`, `llm.ts`, `tools.ts` (the pure parts). Adding a
sixth needs a reason here, the same as a dependency.

**Why.** The first implementation had twelve source files, a two-backend cache keyed by a prompt
hash, and a streaming in-order log built on a completion cursor — more machinery than a CLI that an
operator runs a handful of times deserves. The cache was the biggest piece of it and the one that
paid off least: it only helps when re-running the *same* domains, and its correctness questions
(honouring a cached 404, invalidating on a prompt or taxonomy change) cost more than the credits it
saves.

**What it costs.** Every run re-fetches every domain: one Harmonic credit and one LLM call each, so
appending one company to a 100-domain schedule costs 100 credits. Batch your additions. Re-running
also changes each record's `source.harmonicFetchedAt`, so the output file is no longer byte-stable
across runs; the *schedule* still is.

**Rejected.** Caching only Harmonic (half the machinery for most of the benefit, but still the
404/invalidations question); `--dry-run` (that is `-o /tmp/x.json`); a `--concurrency` flag (nobody
tunes it, and 3 is polite to Harmonic's rate limit).

**Seam.** `harmonic.ts` and `llm.ts` each expose one client interface with one method. A cache is a
decorator around either, in one file, if re-running ever becomes a real workflow.

---

### D14. No fakes in `src/`; the keyless path is a re-dated example file

**Decision.** The extractor has no `mock` provider. `PROVIDERS` is `anthropic | openai | gemini`,
and running it always needs a Harmonic key and one model key. `extract(options, clients?)` takes
its two clients, so tests inject doubles that live in `test/` (`fake-llm.ts`, `fixture-server.ts`).
The no-keys path is `npm run example-schedule`, which re-dates the committed
`data/companies.example.json` to start today.

`extract` takes `Clients` as a required argument rather than an optional override: an optional
parameter would mean the pipeline still knows how to reach the network, and "which branch ran"
becomes a thing to reason about. `cli.ts` is the composition root — it is the only file that reads
`process.env` or validates a flag.

**Why.** The mock provider was 166 lines of invented company data — `MOCK_PLACES`, `MOCK_STAGES`,
`MOCK_HEADCOUNTS`, `MOCK_FUNDING`, `MOCK_TAGS` — shipped in the binary to serve one documented
demo command. The mock Harmonic client had no test users at all (the tests use a fixture HTTP
server, which is a truer double), and the mock LLM's `mapFundingStage` was a second implementation
of a rule that only exists in `SYSTEM_PROMPT`, free to drift from it. Test doubles belong in
`test/`, behind an injection seam; a demo needs demo *data*, not a fake *provider*.

**What it costs.** You can no longer generate a schedule from your own domains without keys.
`example-schedule` gives you 30 hand-written companies dated from today — enough to play and to
run `docker compose up` — but the schedule is the same for everyone who does it.

**Rejected.** Keeping the mock LLM only (still a fake in `src/`, and the injection seam makes it
redundant); a fake LLM *HTTP* server in tests so the CLI subprocess could run the real LangChain
path (it would mean encoding three providers' tool-call wire formats — the pipeline test covers
the pipeline, and the LangChain call itself is covered by a real run).

**Seam.** `Clients` in `index.ts`. Anything satisfying `HarmonicClient` and `LlmClient` can be
handed to `extract`.

---

### D15. The backend's file list

**Decision.** `backend/src/` is twelve files plus `schema.sql`, not the fourteen `04-backend.md`
first sketched. The changes, each an application of the simplicity rules in `CLAUDE.md`:

- `src/db.ts` + `src/schema.sql` instead of `src/db/{db,schema.sql}` — two files do not need a
  directory, and `db/db.ts` stutters. `openDb(file)` opens *and* applies the schema: a database you
  have to remember to `migrate()` is a second step every caller can forget (rule 4).
- `auth/{middleware,anonymous,google}.ts` → one `src/auth.ts`. All three are the same two tables;
  splitting them produced three files averaging thirty lines (rule 1).
- `routes/auth.ts` + `routes/me.ts` → `routes/identity.ts`. `/api/auth/*` and `/api/me` are the
  same question — who is calling — and `me` was two handlers.
- `config.ts` also holds `Deps` and the Hono `AppEnv`. A ten-line `types.ts` imported by everything
  is not worth the file; both types describe "what the app was configured with".
- `createApp(config)` returns `{ app, deps }` rather than just the app, so `server.ts` can log the
  boot line. A factory that builds *and* logs is doing two jobs (rule 4); the tests destructure
  `{ app }` and ignore the rest.

**Two other shapes worth recording.**

`Config.auth` is a discriminated union that carries the Google verifier
(`{ mode: "google"; clientId; allowedDomain?; verify }`), so tests inject a fake verifier without
an optional parameter that exists only for tests (rule 3), and anonymous mode cannot accidentally
reach `google-auth-library`. `loadConfig` is the only thing that builds the real verifier, and
`server.ts` is the only thing that calls `loadConfig`.

`DEV_TODAY` pins the **date**, not the clock: `config.now` stays a real `() => Date` and
`today(config)` is `config.devToday ?? utcDate(config.now())`. Elapsed times therefore stay honest
in dev, and tests move a fake `now` and a pinned date independently.

**Dependencies.** `hono`, `@hono/node-server`, `google-auth-library` and `tsx` per D5/D6/D1.
`zod` is declared in `backend/package.json` rather than borrowed from `shared`'s install: the
backend imports it directly (request bodies are validated at the edge), and a package should
declare what it imports. It is the same version and the same install — nothing new ships.

**No per-request log line.** The app logs boot, schedule reloads, reload failures and 500s — one
line per *event*, as the convention says. Request logging is Caddy's job in production (D7), and a
line per request would have buried the interesting ones and the test output alike.
