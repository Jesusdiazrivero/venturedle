# Venturedle v2 — design package

This folder is meant to be dropped into the root of a **new, empty repository**:

```
venturedle-v2/            ← your new repo
  CLAUDE.md               ← from this package
  docs/                   ← from this package (00–08)
  README-START-HERE.md    ← this file; delete it once the build starts
```

Then open Claude Code in that folder and start with a prompt like:

> Read CLAUDE.md and docs/00-overview.md, then docs/08-build-plan.md. Execute Phase 0 and Phase 1
> exactly as specified, running the acceptance checks at the end of each phase. Stop after Phase 1
> and summarise anything in the docs that was ambiguous or that you deviated from. The v1 repo is
> available at ../venturedle for the porting references the docs mention.

Suggested cadence after that: one Claude Code session per phase (2, 3, 4, 5, 6). Phase 2 needs a
real `HARMONIC_API_KEY` and one LLM key in `.env` for its final acceptance step (recording real
Harmonic fixtures and verifying field names) — everything else in the plan runs keyless.

Decisions already made for you (see `docs/07-decisions.md` for the reasoning):

- TypeScript everywhere, npm workspaces, Node 24.
- Extractor is an offline CLI; `data/companies.json` is the schedule, one company per UTC day.
- Backend: Hono + `node:sqlite`; companies in memory; serves the SPA too.
- Identity: anonymous nickname by default, optional Google sign-in with a Workspace-domain lock.
- Deployment: one Docker image, `docker compose` with Caddy, on a GCP Compute Engine VM first.
- Same seven guessing columns and scoring rules as v1.
- LLM access through LangChain.js (`withStructuredOutput`), used only as the provider abstraction.
- `shared/` is source-only with two entry points (`@venturedle/shared` for the SPA,
  `@venturedle/shared/server` for backend + extractor); the backend runs under `tsx`, no compile
  step, no ESLint.
- Play history is snapshotted into SQLite so editing the schedule file never rewrites past grids.
- `companies.json` is gitignored (it is the answer key); backups are GCE disk snapshots.

Things the docs deliberately leave to the implementer: exact CSS, exact prompt wording (an outline
is given), default LLM model ids (put them in one constant; they go stale), and the contents of
`data/companies.example.json`.

One thing to verify early with real keys: Harmonic's REST field names (`docs/03-extractor.md`
flags this). The mapper is specified to accept both snake_case and camelCase so a mismatch is a
five-minute fix, not a redesign.
