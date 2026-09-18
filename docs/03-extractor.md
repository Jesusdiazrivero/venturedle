# 03 — Extractor

A CLI that turns a list of domains into `data/companies.json`. It is the only place that talks to
Harmonic or to an LLM, and it never runs in production.

## Usage

```bash
# from the repo root
npm run extract -- --domains data/domains.txt --start 2026-10-01
# equivalently
npm run extract -- -d data/domains.txt -s 2026-10-01 -o data/companies.json

# options
#   -d, --domains <file>     required. One domain per line. Blank lines and lines starting with # are ignored.
#   -s, --start <date>       required. YYYY-MM-DD (UTC). First valid company gets this date.
#   -o, --out <file>         default data/companies.json
#   --provider <name>        anthropic | openai | gemini. Default: inferred from which *_API_KEY is set.
#   --model <id>             override the provider's default model
#                            (concurrency is fixed at 3; there are no other flags — see D13)

npm run extract -- validate data/companies.json      # zod-validate an existing file, exit 1 on failure
```

Environment (a root `.env` is loaded by `tsx --env-file-if-exists=../.env`, so there is no
`dotenv` dependency; `.env.example` documents these):

```
HARMONIC_API_KEY=...          # required for extract; there is no offline mode (D14)
ANTHROPIC_API_KEY=...         # exactly one of these three is needed
OPENAI_API_KEY=...
GEMINI_API_KEY=...            # (LangChain's own name is GOOGLE_API_KEY; accept both and pass the key explicitly to the provider factory)
HARMONIC_BASE_URL=            # optional; default https://api.harmonic.ai — tests point it at a fixture server
```

All file paths given on the command line or in env are resolved against the **repo root**
(`process.env.INIT_CWD ?? process.cwd()` — npm sets `INIT_CWD` to where `npm run` was invoked),
not against `extractor/`, so `npm run extract -- -d data/domains.txt` means what it looks like.

Provider inference: if `--provider` is absent, pick the single provider whose key is set; if zero
or more than one are set, fail with a message telling the user to pass `--provider`.

`data/domains.txt` format:

```
# Venturedle schedule — October 2026
klarna.com
revolut.com
www.n26.com        # scheme, www. and paths are stripped; this becomes n26.com
https://getmonzo.co.uk/about
```

Normalisation: strip a trailing `#…` comment, trim, lowercase, drop scheme, `www.`, path, query
and port. Duplicates (after normalisation) are an error, not a warning: the id must be unique.

## Pipeline

For each domain, in file order, with bounded concurrency:

```
domain ─▶ normalise ─▶ Harmonic fetch ─▶ evidence ─▶ LLM extract ─▶ merge + validate ─▶ record
                                                                          │
                                                                          └─▶ rejected.json on failure
```

then: sort valid records in **input order**, assign `date = start + i` for `i = 0..n-1`, write the
file. Rejected domains do not consume a date; the log says so loudly because it shifts everyone
after them:

```
✔ klarna.com        → 2026-10-01  Klarna          Fintech, Payments · SE · 2005 · Public · >$1B · 1,001–5,000
✘ stealthco.xyz     rejected: harmonic_not_found
✔ revolut.com       → 2026-10-02  Revolut         ...
…
Wrote 98 companies to data/companies.json (2026-10-01 → 2027-01-06). 2 rejected → data/rejected.json
⚠ Rejections shift the schedule. Fix or remove them in domains.txt and re-run.
```

### 1. Harmonic fetch

Harmonic's v2 REST API enriches a company by domain:

```
POST https://api.harmonic.ai/companies?website_domain={domain}
headers: apikey: $HARMONIC_API_KEY, accept: application/json
```

An empty POST body. A 200 returns the company object; a 404 (or an object with `id: -1`) means
Harmonic has no record → `harmonic_not_found`. 429 → exponential backoff (1s, 2s, 4s, 8s, 16s;
then give up with `harmonic_rate_limited`). Any 5xx → retry 3× then `harmonic_error`.
**401/403 from Harmonic or from the LLM provider aborts the whole run immediately** with a clear
"check your API key" message and exit code 2 — a bad key must never turn into 100 rejected
domains and an empty output file.

**Field names must be verified against a live response on the first run.** Harmonic's MCP layer
returns camelCase (`logoUrl`, `funding.fundingTotal`, `foundingDate.date`); the REST API is
believed to return snake_case (`logo_url`, `funding.funding_total`, `founding_date.date`). Write
the mapper as a small `pick(obj, ["logo_url", "logoUrl"])` helper that accepts both. Fields we
care about, by intent:

| Intent              | Candidates in Harmonic response                                                            |
| ------------------- | ------------------------------------------------------------------------------------------ |
| harmonic id         | `id`                                                                                       |
| name                | `name`                                                                                     |
| logo                | `logo_url` / `logoUrl`                                                                     |
| description         | `description`                                                                              |
| website domain      | `website.domain`                                                                           |
| headcount           | `headcount`                                                                                |
| total funding (USD) | `funding.funding_total` / `funding.fundingTotal`                                           |
| stage (raw)         | `funding.funding_stage` / `funding.fundingStage` (e.g. `SERIES_B`, `EXITED`)               |
| round types         | `funding.funding_rounds[].funding_round_type` (may be absent without Deal Data add-on)     |
| founding date       | `founding_date.date` / `foundingDate.date`                                                 |
| HQ                  | `location.country`, `location.state`, `location.city` (country is a _name_, e.g. "Sweden") |
| tags                | `tags_v2` (array of strings or of `{type, display_value}` objects — flatten to strings)    |
| customer type       | `customer_type` (string or array, e.g. `"B2B"`)                                            |

Fallback logo when Harmonic has none: `https://www.google.com/s2/favicons?domain={domain}&sz=128`.

### 2. Evidence

A compact, LLM-friendly object built from the raw response. Only what's needed for the seven
fields; no employees, no investors, no timeseries. Roughly:

```jsonc
{
  "domain": "klarna.com",
  "name": "Klarna",
  "description": "Klarna offers a global payments and commerce network ...",
  "tags": ["Fintech", "Payments", "BNPL"],
  "customerType": "B2C",
  "location": {
    "country": "Sweden",
    "state": "Stockholm",
    "city": "Stockholm",
  },
  "foundingDate": "2004-09-01",
  "funding": {
    "stageRaw": "EXITED",
    "totalUsd": 9460186174,
    "roundTypes": [
      "PRE_SEED",
      "SERIES_A",
      "SERIES_B",
      "SERIES_C",
      "LATER_STAGE",
      "IPO",
      "DEBT",
    ],
  },
  "headcount": 4585,
}
```

### 3. LLM extraction

**Division of labour, non-negotiable:** numbers come from Harmonic, categories come from the LLM.
The LLM never outputs `totalFundingUsd` or `headcount`; if Harmonic lacks either, the domain is
rejected (`missing_headcount`, `missing_funding_total`). The LLM _may_ supply `foundedYear` only
when Harmonic's founding date is missing, and only if the description or its own knowledge makes
it confident; otherwise it returns `null` and the domain is rejected (`missing_founded_year`).

The LLM is asked for a strict JSON object:

```ts
const ExtractionSchema = z.object({
  sectors: z.array(z.enum(SECTORS)).min(1).max(3), // primary first
  businessModel: z.array(z.enum(BUSINESS_MODELS)).min(1),
  hqCountry: z.string().regex(/^[A-Z]{2}$/), // from the location name
  foundedYear: z.number().int().nullable(), // Harmonic value echoed back, or filled if missing
  fundingStage: z.enum(FUNDING_STAGES),
  confidence: z.enum(["high", "medium", "low"]),
  notes: z.string().max(300), // one line: why, esp. for stage/sector calls
});
```

Prompt outline (system):

> You normalise startup data for a guessing game. Given evidence about one company, return the
> fields in the schema. Rules: pick 1–3 sectors from the allowed list, most specific/primary
> first; never invent numbers; map the HQ country name to ISO-3166-1 alpha-2; map the funding
> stage: PRE_SEED→Pre-seed, SEED→Seed, SERIES_A/B/C→Series A/B/C, SERIES_D or later or
> LATER_STAGE/PRIVATE_EQUITY with ≥ Series C history→Series D+; EXITED→Public if round types
> include IPO/PUBLIC_EQUITY_OFFERING or the description says it is listed, otherwise Acquired;
> unknown/other→best judgement from description and funding total, note it. Business model:
> B2B, B2C, B2B2C and/or Marketplace (a company can be several).

Implementation: **LangChain.js** — `@langchain/core` plus the three provider packages
`@langchain/anthropic`, `@langchain/openai`, `@langchain/google-genai` — pinned to one major. The
provider switch is a small factory that returns a `BaseChatModel` (`new ChatAnthropic({ apiKey,
model, temperature: 0 })` etc.; `initChatModel("anthropic:claude-…")` from `langchain` is an
acceptable shortcut if it is stable in the pinned major), and the call is
`model.withStructuredOutput(ExtractionSchema).invoke([system, human])`. Pass `apiKey` explicitly
so our env var names (incl. `GEMINI_API_KEY`) work regardless of the library's defaults. Keep the
schema provider-friendly: prefer `z.string().length(2)` over regex for `hqCountry` and re-validate
the result with the strict zod schema afterwards — `withStructuredOutput` uses native tool/JSON
modes that differ slightly per provider in which schema keywords they accept. No chains, prompt
templates, agents or LangSmith in v2: the library is used only for the provider abstraction and
structured output. Default models (override with `--model`): put them in one constant
(`DEFAULT_MODELS` in `llm.ts`) with today's sensible defaults per provider and note in the README
that they go stale. Temperature 0.

**There is no offline or mock provider** (D14). Running the extractor always costs one Harmonic
credit and one model call per domain. The keyless path is `npm run example-schedule`, which
re-dates the committed `data/companies.example.json` to start today — enough to play and to bring
up the production-like Docker run, but it is not a schedule built from *your* domains.

Retries: one retry on schema-validation failure with the validation error appended to the prompt;
then `llm_invalid_output`.

### 4. Merge and validate

```ts
const record: Company = {
  id: domain,
  date: "<assigned later>",
  domain,
  name,
  logoUrl,
  sectors,
  businessModel,
  hqCountry,
  region: regionOf(hqCountry),
  foundedYear: harmonicYear ?? llm.foundedYear,
  fundingStage,
  totalFundingUsd: harmonic.totalUsd,
  headcount: harmonic.headcount,
  source: {
    harmonicId,
    harmonicFetchedAt,
    llm: `${provider}/${model}`,
    notes: llm.notes,
  },
};
CompanySchema.parse(record); // reject on failure with zod_<path>
```

Low-confidence extractions are **kept** but flagged in the log (`⚠ low confidence`) and in
`source.notes`, so the operator can eyeball them in the JSON before deploying.

### 5. Output

`data/companies.json` (pretty-printed, 2-space, trailing newline — it is meant to be diffed and
hand-edited) and `data/rejected.json`:

```json
[
  { "domain": "stealthco.xyz", "reason": "harmonic_not_found" },
  { "domain": "acme.io", "reason": "missing_headcount", "harmonicId": 12345 }
]
```

Re-running with the same inputs produces the same schedule, byte for byte except for `generatedAt`
and each record's `source.harmonicFetchedAt`. It is not free: there is no cache (D13), so every
domain is fetched and extracted again.

## Code layout

```
extractor/
  package.json            # scripts.extract = "tsx src/cli.ts"; deps: commander, zod, @langchain/core, @langchain/anthropic, @langchain/openai, @langchain/google-genai, tsx
  src/                    # five files, and no more without a reason (D13). No fakes here (D14).
    cli.ts                # composition root: the flags, env → clients, the exit code
    index.ts              # the pipeline: domains → fetch → extract → merge → date → write, plus the log
    harmonic.ts           # the HTTP client, and toEvidence/toFacts (tolerant field picking)
    llm.ts                # provider factory, ExtractionSchema, the prompt
    tools.ts              # the pure parts: paths, domains file, dates, buildRecord, mapPool, writers
  scripts/
    example-schedule.ts   # re-date companies.example.json to start today — the keyless path
  test/
    fixtures/domains.txt       # the 5-domain file pipeline.test.ts uses
    fixtures/harmonic/*.json   # 3–4 anonymised real responses (snake_case) — record on first run
    fixture-server.ts          # http.createServer serving fixtures by website_domain
    fake-llm.ts                # the LLM test double, canned per fixture domain
    tools.test.ts
    harmonic.test.ts      # the client (retries, 404, abort) and the field picking
    llm.test.ts           # provider inference and ExtractionSchema
    pipeline.test.ts      # extract() in process: real Harmonic client + fixture server + fake LLM
    cli.test.ts           # the CLI as a subprocess: flags, validate, exit codes
```

`extract(options, clients)` takes both clients; `cli.ts` is the only thing that reads `process.env`
or validates a flag. Testing: spin up a tiny `http.createServer` that serves fixtures by domain,
point the client's `baseUrl` at it, and pass a fake LLM. Never call the real API in tests, and
never ship a fake in `src/` (D14).

## Operational notes for the README

- Cost: one Harmonic enrichment credit per domain, one small LLM call (~1–2k tokens) per domain,
  **on every run** — there is no cache (D13). 100 domains ≈ cents.
- To extend the schedule later, append domains to `domains.txt` and re-run with the **same
  `--start`**; existing dates are unchanged as long as nothing before them was removed or rejected
  differently, but the whole file is re-fetched. Re-running a 100-domain schedule to add one
  company costs 100 credits, so batch your additions.
- **`data/companies.json` is the answer key with dates attached.** It is gitignored by default so
  a public fork does not publish its own solutions; treat it as deploy-time data (copied to the
  server, backed up with the database). `data/domains.txt` can be committed if you don't mind
  revealing the pool without the order. Operators of a private repo may commit whatever they like.
  Only `data/companies.example.json` is committed.
- To skip a company, delete its object from `companies.json` (leaves a gap; later puzzle numbers
  are unaffected because the backend stores the puzzle number with each play) or remove the domain
  and re-run (shifts the schedule). Both are valid; the backend handles gaps.
