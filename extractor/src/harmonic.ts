/**
 * The only thing that talks to Harmonic. Returns the raw response body — mapping happens in
 * `evidence.ts` so a wrong field name can be fixed against the cache without spending credits.
 */
import { createCache, type Cache } from "./cache.js";
import { AbortRunError, type RejectionReason } from "./types.js";

export const DEFAULT_BASE_URL = "https://api.harmonic.ai";

/** 429 backoff, in ms; running out of them is `harmonic_rate_limited`. */
const RATE_LIMIT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const SERVER_ERROR_RETRIES = 3;

export interface CachedResponse {
  fetchedAt: string;
  status: number;
  body: unknown;
}

export type HarmonicFetch =
  | { ok: true; fetchedAt: string; body: unknown }
  | { ok: false; reason: RejectionReason };

export interface HarmonicClient {
  fetchCompany(domain: string): Promise<HarmonicFetch>;
}

export interface HarmonicOptions {
  apiKey: string;
  baseUrl?: string;
  /** null disables caching (`--no-cache`) */
  cacheDir?: string | null;
  fetchImpl?: typeof fetch;
  /** injected in tests so backoff does not actually wait */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function toFetch(cached: CachedResponse): HarmonicFetch {
  if (cached.status === 404) return { ok: false, reason: "harmonic_not_found" };
  if (isMissingRecord(cached.body))
    return { ok: false, reason: "harmonic_not_found" };
  return { ok: true, fetchedAt: cached.fetchedAt, body: cached.body };
}

/** Harmonic answers "no record" either with a 404 or with a 200 carrying `id: -1`. */
function isMissingRecord(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { id?: unknown }).id === -1
  );
}

export function createHarmonicClient(options: HarmonicOptions): HarmonicClient {
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const cache: Cache = createCache(options.cacheDir ?? null);

  async function request(domain: string): Promise<CachedResponse> {
    const url = `${baseUrl}/companies?website_domain=${encodeURIComponent(domain)}`;
    let rateLimited = 0;
    let serverErrors = 0;

    for (;;) {
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { apikey: options.apiKey, accept: "application/json" },
        });
      } catch (err) {
        // A connection failure is as retryable as a 500.
        if (serverErrors++ >= SERVER_ERROR_RETRIES) {
          throw new HarmonicFailure(
            "harmonic_error",
            `${domain}: ${(err as Error).message}`,
          );
        }
        await sleep(1_000);
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        throw new AbortRunError(
          `Harmonic returned ${res.status} for ${domain} — check HARMONIC_API_KEY.`,
        );
      }
      if (res.status === 404) {
        return { fetchedAt: new Date().toISOString(), status: 404, body: null };
      }
      if (res.status === 429) {
        const delay = RATE_LIMIT_BACKOFF_MS[rateLimited++];
        if (delay === undefined)
          throw new HarmonicFailure("harmonic_rate_limited", domain);
        await sleep(delay);
        continue;
      }
      if (res.status >= 500) {
        if (serverErrors++ >= SERVER_ERROR_RETRIES) {
          throw new HarmonicFailure(
            "harmonic_error",
            `${domain}: HTTP ${res.status}`,
          );
        }
        await sleep(1_000);
        continue;
      }
      if (!res.ok) {
        throw new HarmonicFailure(
          "harmonic_error",
          `${domain}: HTTP ${res.status}`,
        );
      }
      return {
        fetchedAt: new Date().toISOString(),
        status: res.status,
        body: await res.json(),
      };
    }
  }

  return {
    async fetchCompany(domain) {
      const key = `harmonic/${domain}.json`;
      const cached = await cache.read<CachedResponse>(key);
      if (cached) return toFetch(cached); // cached 404s are honoured too — `--no-cache` retries them

      let fresh: CachedResponse;
      try {
        fresh = await request(domain);
      } catch (err) {
        if (err instanceof HarmonicFailure)
          return { ok: false, reason: err.reason };
        throw err;
      }
      await cache.write(key, fresh);
      return toFetch(fresh);
    },
  };
}

class HarmonicFailure extends Error {
  constructor(
    readonly reason: RejectionReason,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "HarmonicFailure";
  }
}

const MOCK_COUNTRIES = [
  { country: "Sweden", state: "Stockholm County", city: "Stockholm" },
  { country: "United States", state: "California", city: "San Francisco" },
  { country: "Germany", state: "Berlin", city: "Berlin" },
  { country: "Spain", state: "Madrid", city: "Madrid" },
  { country: "United Kingdom", state: "England", city: "London" },
  { country: "Singapore", state: "Singapore", city: "Singapore" },
  { country: "Brazil", state: "São Paulo", city: "São Paulo" },
];
const MOCK_STAGES = [
  "SEED",
  "SERIES_A",
  "SERIES_B",
  "SERIES_C",
  "SERIES_D",
  "LATER_STAGE",
  "EXITED",
];
const MOCK_HEADCOUNTS = [7, 30, 120, 350, 800, 2_500, 9_000];
const MOCK_FUNDING = [
  500_000, 3_000_000, 12_000_000, 60_000_000, 250_000_000, 750_000_000,
  2_500_000_000,
];
// Values from the shared taxonomy, so a mock schedule reads like a real one.
const MOCK_TAGS = [
  ["Fintech", "Payments"],
  ["AI / ML", "Developer Tools"],
  ["Marketplace", "E-commerce"],
  ["Healthtech", "SaaS Infrastructure"],
  ["Climate & Energy"],
  ["Logistics & Supply Chain"],
  ["Cybersecurity", "Enterprise Software"],
];

/** FNV-1a. Any stable hash would do; this one is four lines and needs no dependency. */
export function hashDomain(domain: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < domain.length; i++) {
    h ^= domain.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * `--provider mock` with no `HARMONIC_BASE_URL`: a plausible company invented from the domain, in
 * the same snake_case shape as the real API, so the rest of the pipeline is exercised unchanged.
 */
export function createMockHarmonicClient(): HarmonicClient {
  return {
    async fetchCompany(domain) {
      const h = hashDomain(domain);
      const label = domain.split(".")[0]!;
      const name = label.charAt(0).toUpperCase() + label.slice(1);
      const place = MOCK_COUNTRIES[h % MOCK_COUNTRIES.length]!;
      const stage = MOCK_STAGES[h % MOCK_STAGES.length]!;
      return {
        ok: true,
        fetchedAt: "1970-01-01T00:00:00.000Z", // fixed: mock runs must be byte-identical
        body: {
          id: 100_000 + (h % 900_000),
          name,
          logo_url: null, // exercises the favicon fallback
          description: `${name} is a mock company generated from the domain ${domain} for offline runs.`,
          website: { domain },
          headcount: MOCK_HEADCOUNTS[h % MOCK_HEADCOUNTS.length]!,
          funding: {
            funding_total: MOCK_FUNDING[h % MOCK_FUNDING.length]!,
            funding_stage: stage,
            funding_rounds:
              stage === "EXITED" ? [{ funding_round_type: "IPO" }] : [],
          },
          founding_date: { date: `${1995 + (h % 30)}-06-01` },
          location: place,
          tags_v2: MOCK_TAGS[h % MOCK_TAGS.length]!,
          customer_type: h % 2 === 0 ? "B2B" : "B2C",
        },
      };
    },
  };
}
