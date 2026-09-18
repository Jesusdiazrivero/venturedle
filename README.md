# Venturedle

A daily startup-guessing game in the Wordle / Loldle family. One secret company per UTC day; each
guess is scored across seven columns — sector, HQ country, founded year, funding stage, total
funding, headcount, business model — with green / yellow / grey feedback and higher/lower arrows.
Leaderboards rank players by guesses and by time.

Open source and self-hostable: with a Harmonic API key and one LLM key (Anthropic, OpenAI or
Gemini) you generate your own schedule and run the whole thing with `docker compose`.

> **Status: under construction.** Phases 0–1 of `docs/08-build-plan.md` are done (workspace
> scaffold and the shared data/scoring package). The backend, frontend and extractor land in
> later phases. This README is a stub until Phase 5.

## Quick start (no API keys)

```bash
npm install
cp .env.example .env
npm run dev          # backend :8080 + frontend :5173, against data/companies.example.json
```

## Layout

| Folder       | What                                                                             |
| ------------ | -------------------------------------------------------------------------------- |
| `extractor/` | CLI: a domains file + a start date → `data/companies.json` via Harmonic + an LLM |
| `backend/`   | Hono API + SQLite; also serves the built SPA                                     |
| `frontend/`  | Vite + React SPA                                                                 |
| `shared/`    | types, enums, sector taxonomy, zod schemas, pure scoring                         |

## Commands

```bash
npm run dev          # backend + frontend, example data, no keys needed
npm test             # vitest, all workspaces
npm run typecheck    # tsc --noEmit per workspace
npm run build        # typecheck + vite build
npm run extract -- -d data/domains.txt -s 2026-10-01   # needs keys in .env
```

## Docs

The design lives in [`docs/`](docs/) — start with [`docs/00-overview.md`](docs/00-overview.md).

## License

MIT — see [LICENSE](LICENSE).
