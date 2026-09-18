# Venturedle v2 — Overview

Venturedle is a daily startup-guessing game in the Wordle / Loldle family. Every day there is one
secret company. Players guess companies from a pool; each guess is scored across seven columns
(sector, HQ country, founded year, funding stage, total funding, headcount, business model) with
green / yellow / grey feedback and higher/lower arrows, until they hit the right one. Leaderboards
rank players by number of guesses and by time to solve.

v2 is a ground-up rewrite of the v1 repo with one goal: **an open-source app that anyone can run
with a Harmonic API key and one LLM API key (Gemini, OpenAI or Anthropic).** Everything in these
docs bends toward that. When a choice is between "more capable" and "fewer moving parts", pick
fewer moving parts.

## The three components

```
 data/domains.txt                 data/companies.json               SQLite (data/venturedle.db)
 (one domain per line)            (one record per day)              (players, plays, guesses)
        │                                 │                                    ▲
        ▼                                 ▼                                    │
 ┌─────────────┐   Harmonic + LLM   ┌─────────────┐   HTTP/JSON    ┌───────────┴─┐
 │  extractor  │ ─────────────────▶ │   backend   │ ◀───────────── │  frontend   │
 │  (CLI)      │                    │ (Hono API)  │ ─────────────▶ │ (React SPA) │
 └─────────────┘                    └─────────────┘  also serves   └─────────────┘
   runs offline,                     the only thing   the built SPA
   on a laptop                       that runs 24/7
```

1. **Extractor** (`extractor/`) — a CLI. Input: a text file with one company domain per line and a
   start date. For each domain it pulls the company from Harmonic, hands the raw evidence to an LLM
   that normalises it into the seven guessing fields, and writes `data/companies.json` where the
   _n_-th valid company is scheduled for `startDate + n days`. It runs on a laptop; nothing in
   production depends on Harmonic or the LLM. See `03-extractor.md`.
2. **Backend** (`backend/`) — a small Hono HTTP API on Node with SQLite (`node:sqlite`, no native
   build). It loads `companies.json` into memory, knows which company is today's, evaluates guesses
   server-side, stores every guess incrementally, and computes leaderboards. It also serves the
   built frontend so production is a single container. See `04-backend.md`.
3. **Frontend** (`frontend/`) — a Vite + React SPA: pick a nickname (or sign in with Google when the
   operator enables it), guess, watch the grid fill in, share the emoji grid, browse leaderboards.
   See `05-frontend.md`.

A fourth folder, `shared/`, is **not a component** — it is a tiny TypeScript package holding the
types, enums, sector taxonomy and the pure scoring function that all three components import. It
has no runtime of its own. See `02-data-contract.md`.

## What "simple" means here, concretely

- One language (TypeScript), one package manager (npm workspaces), one `npm install`.
- One production process (the backend) and one file it needs (`companies.json`) plus one SQLite
  file it owns. No Firestore, no Cloud SQL, no message queues, no cron in prod.
- Zero-config local run: `npm install && npm run dev` starts the backend + frontend against the
  shipped `data/companies.example.json` in anonymous-nickname mode. No API keys needed to play.
  The extractor's `--provider mock` mode is fully offline too, so even a production-like Docker run
  needs no keys.
- Keys are only needed to _generate a new company list_ (extractor) or to _turn on Google sign-in_
  (backend). Both are opt-in.
- Deployment is `docker compose up -d` on any Linux box. GCP is the documented first target
  (Compute Engine e2-micro); the compose file is cloud-agnostic on purpose. See `06-deployment.md`.

## Non-goals for v2

Multiple game modes, hints, streak mechanics beyond what falls out of the data, admin UIs, multi-
tenant deployments, rate limiting beyond the trivial, anti-cheat. Some of these are cheap later;
`07-decisions.md` records where the seams are. Do not build them now.

## Reading order for a Claude Code session

1. `CLAUDE.md` (repo root) — invariants and commands. Read first, always.
2. `01-game-rules.md` — what the game is; scoring rules are normative.
3. `02-data-contract.md` — the record shape shared by all three components.
4. `03-extractor.md`, `04-backend.md`, `05-frontend.md` — one per component.
5. `06-deployment.md` — Docker, compose, GCP.
6. `07-decisions.md` — why things are the way they are (ADR-style), and the seams left open.
7. `08-build-plan.md` — the phased plan with acceptance criteria. Work through it in order.

## Provenance

This design is derived from the v1 repo (`venturedle/`, June 2026): the seven columns, the bucket
tables, the scoring rules, the share grid and the "answer never leaves the backend" property are
carried over intact. Everything about _how_ the pool is built, stored, served and deployed is new.
Where a v1 file is a good reference for porting (e.g. `backend/src/lib/evaluateGuess.ts` and its
33 unit tests), the component docs say so.
