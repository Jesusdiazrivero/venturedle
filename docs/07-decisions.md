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
