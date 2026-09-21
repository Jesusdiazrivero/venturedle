# 05 — Frontend

A Vite + React 18 SPA in TypeScript. No router library, no state library, no UI kit, no CSS
framework: plain CSS with custom properties, hand-rolled `fetch` wrappers, and three views switched
by a tiny hash router (`#/`, `#/leaderboard`). The v1 look — Wordle-ish grid, dark mode following
the OS — is kept.

Dependencies: `react`, `react-dom`. Dev: `vite`, `@vitejs/plugin-react`, `typescript`, `vitest`,
`@testing-library/react`, `jsdom`. Nothing else — no router, no state library, no `jest-dom`. The
SPA imports from `@venturedle/shared` (the client entry: enums, `COLUMN_DEFS`, `CompanyLite`, DTOs)
and never from `@venturedle/shared/server`, which is where `Company` lives.

## Views

```
┌──────────────────────────────────────────────────────────────────┐
│ VENTUREDLE            #12 · 2026-10-12 UTC       [Board] [Kate ▾] │  ← Header (always)
├──────────────────────────────────────────────────────────────────┤
│  [ Guess a company…                                           ]   │  ← Picker (Play view)
│    ▸ Klarna   ▸ Klaviyo   ▸ Kry                                   │
│                                                                    │
│  Company   Sector   HQ   Founded  Stage  Funding  Headcount Model  │  ← GuessGrid, newest first
│  Revolut   🟩       🟩   ⬜ ↓     🟨 ↑  🟩       ⬜ ↓      🟨      │
│  Monzo     🟨       🟩   ⬜ ↓     ⬜ ↑  ⬜ ↑     ⬜ ↓      🟩      │
│                                                                    │
│  ⏱ 02:41   ·   2 guesses                                          │  ← StatusBar (running clock)
└──────────────────────────────────────────────────────────────────┘
```

1. **Onboarding** — shown when there is no session token. Anonymous mode: a single nickname field
   and a "Play" button. Google mode: the Google Identity Services button (script loaded on demand
   from `accounts.google.com/gsi/client`; client id from `/api/config`). `forbidden_domain` is
   shown in plain words using `AppConfig.googleAllowedDomain` ("Sign in with your @example.com
   account"); `invalid_token` shows a generic "Sign-in failed, try again".
2. **Play** (`#/`) — the puzzle. States:
   - `no puzzle today`: friendly empty state with the countdown to the next UTC midnight (the next
     scheduled date is not disclosed).
   - `playing`: picker + grid + running clock. The clock starts from `startedAt` returned by the
     server, so a reload does not reset it. `POST /api/results/today/start` fires on mount (once per
     date) so the clock is fair from the moment the puzzle is visible.
   - `solved`: picker disabled, grid frozen, **WinPanel** with the answer (logo + name), guess count,
     final time, the share text in a `<pre>`, a "Copy" button, a "See leaderboard" link, and the
     countdown to the next puzzle.
3. **Leaderboard** (`#/leaderboard`) — two toggles: scope (Today / All-time) and metric (Guesses /
   Time). A table of up to 50 rows; the current player's row highlighted, and appended at the
   bottom with its rank if outside the top 50. Unsolved players do not appear; the empty state says
   "Nobody has solved today's puzzle yet — be the first."
4. **Profile menu** (header dropdown) — change nickname (`PATCH /api/me`), sign out (`DELETE
/api/auth/session` then clear `localStorage`). In anonymous mode signing out warns that the
   history is unrecoverable.

## Components

```
frontend/src/
  main.tsx               # mount
  App.tsx                # loads /api/config; Onboarding vs game; hash routing; header data (me, puzzle)
  api.ts                 # typed fetch wrappers, bearer injection, ApiError with .code; clears the token on 401
  session.ts             # the token in localStorage (key: "venturedle.token") as an external store
  hooks.ts               # useHashRoute; useCountdown (1 s tick to an ISO target); useElapsed (frozen once solved)
  Onboarding.tsx         # nickname form (anonymous) or the Google button; wording for forbidden_domain
  Play.tsx               # the puzzle, the status bar and the win panel
  Leaderboard.tsx        # the two toggles and the table
  Header.tsx             # title, #N · date, nav link, profile menu (rename, sign out)
  CompanyPicker.tsx      # typeahead over CompanyLite[]; excludes guessed ids; Enter picks first match; ↑/↓ to move
  GuessGrid.tsx          # column-driven from COLUMN_DEFS (shared); newest guess on top; staggered reveal
                         # animation; the cell (colour + arrow + displayValue) and the ISO-2 flag live here
  GoogleButton.tsx       # GIS wrapper; loads the script on demand, never rendered in anonymous mode
  styles.css
```

Flat, and fewer files than this doc first sketched: see `07-decisions.md` D16 for what merged and
why. `formatElapsed` (the clock, the countdown and the share-text header must agree) comes from
`@venturedle/shared`.

Typeahead matching: case-insensitive `includes` on `name`, plus a match on `id` (domain) so typing
"klarna.com" works; show at most 8; logos with `onError` hide-on-404.

## Data flow

```
App mount ──▶ GET /api/config ──▶ token? ──no──▶ Onboarding ──▶ POST /api/auth/* ──▶ store token ─┐
                                    │yes                                                          │
                                    ▼◀───────────────────────────────────────────────────────────┘
                         GET /api/companies  +  GET /api/puzzle/today  +  GET /api/results/today
                                    │
                                    ▼
                    status not_started ──▶ POST /api/results/today/start ──▶ PlayState
                                    │
                    pick company ──▶ POST /api/results/today/guesses ──▶ PlayState (replace, don't merge)
```

The server's `PlayState` is the single source of truth; the client never computes feedback or
win state. Every mutation response is a full `PlayState` and simply replaces local state, which is
what makes reload/resume trivial. A `401 unauthorized` on any authenticated call clears the token
and returns to Onboarding (the session was revoked or the database was reset); a guess after a
solve simply returns the same `PlayState`, so there is nothing to special-case.

Midnight rollover while the tab is open: `useCountdown` reaching zero should trigger a refetch of
`puzzle/today` and `results/today` (and clear the grid). Not built yet — it is on the Phase 6 list
in `08-build-plan.md`; today the countdown runs to `00:00` and a reload picks up the new puzzle.

## Visual notes

- Colours as CSS variables: `--green #6aaa64`, `--yellow #c9b458`, `--grey #787c7e`, light/dark
  via `prefers-color-scheme` (port from v1).
- Grid: `grid-template-columns: minmax(140px, 1.4fr) repeat(7, minmax(0, 1fr))`; on narrow screens
  (< 720 px) the grid scrolls horizontally inside a wrapper rather than reflowing — a Wordle-style
  grid is unreadable when wrapped.
- Reveal animation: each cell flips in with `animation-delay: i * 80ms` (v1 has this).
- The flag for `hqCountry` is a regional-indicator emoji pair computed from the ISO-2 code; fall
  back to the code as text if the platform lacks flag emoji (Windows) — check with a canvas
  measurement once and cache the result.
- Accessibility: cells carry `aria-label="Sector: Fintech, Payments — partial match"`; colours are
  never the only signal (arrows and text are present); the picker is a proper listbox with keyboard
  navigation.

## Build and dev

```bash
npm run dev -w frontend        # Vite on :5173, proxies /api → http://localhost:8080
npm run build -w frontend      # → frontend/dist, served by the backend in prod
```

`vite.config.ts`: `server.proxy["/api"] = "http://localhost:8080"`, `build.outDir = "dist"`, alias
`@venturedle/shared` resolved through the workspace (no manual path alias). No `VITE_*` env vars
are needed: everything the SPA must know at runtime (`authMode`, `googleClientId`,
`googleAllowedDomain`) comes from `GET /api/config`, so one build works for every deployment.
`npm run build -w frontend` is `vite build` only; type-checking is the separate root `typecheck`.

## Tests

Vitest + Testing Library (jsdom), a handful of focused tests. `test/fake-api.ts` stubs `fetch` with
routes keyed by `"<METHOD> <path>"` and records the calls; an unrouted request fails the test.

- Onboarding renders the nickname form in anonymous mode and the Google button in google mode.
- Play calls `start` exactly once (rendered inside `StrictMode`, whose double-invoked effects are
  the thing worth guarding against), renders guesses newest-first, disables the picker and shows the
  answer and the share text when solved, and shows the empty state when nothing is scheduled.
- Picker excludes guessed companies, matches on the domain, and picks the highlighted match on Enter.
- Leaderboard toggles change the query string, highlight `isMe`, and show the empty state.

End-to-end (optional, phase 6): one Playwright script against `docker compose up` that creates a
player, guesses the fixture answer and asserts the share text — it doubles as a deploy smoke test.
