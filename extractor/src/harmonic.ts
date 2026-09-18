/**
 * Everything Harmonic-shaped: the HTTP call and the mapping from a raw response
 * to the two things the pipeline needs — the numbers we copy verbatim (`HarmonicFacts`) and the
 * compact, LLM-facing `Evidence`.
 *
 * Field picking is deliberately tolerant: the REST API is believed to return snake_case and the
 * MCP layer returns camelCase, so every accessor accepts both. `docs/03-extractor.md` has the
 * table of intents; this file is its implementation.
 */
import { AbortRunError, type RejectionReason } from "./tools.js";

export const DEFAULT_BASE_URL = "https://api.harmonic.ai";

/** 429 backoff, in ms; running out of them is `harmonic_rate_limited`. */
const RATE_LIMIT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
const SERVER_ERROR_RETRIES = 3;

export type HarmonicFetch =
  | { ok: true; fetchedAt: string; body: unknown }
  | { ok: false; reason: RejectionReason };

export interface HarmonicClient {
  fetchCompany(domain: string): Promise<HarmonicFetch>;
}

export interface HarmonicOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** injected in tests so backoff does not actually wait */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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

  return {
    async fetchCompany(domain) {
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
        } catch {
          // A connection failure is as retryable as a 500.
          if (serverErrors++ >= SERVER_ERROR_RETRIES)
            return { ok: false, reason: "harmonic_error" };
          await sleep(1_000);
          continue;
        }

        if (res.status === 401 || res.status === 403) {
          throw new AbortRunError(
            `Harmonic returned ${res.status} for ${domain} — check HARMONIC_API_KEY.`,
          );
        }
        if (res.status === 404)
          return { ok: false, reason: "harmonic_not_found" };
        if (res.status === 429) {
          const delay = RATE_LIMIT_BACKOFF_MS[rateLimited++];
          if (delay === undefined)
            return { ok: false, reason: "harmonic_rate_limited" };
          await sleep(delay);
          continue;
        }
        if (res.status >= 500) {
          if (serverErrors++ >= SERVER_ERROR_RETRIES)
            return { ok: false, reason: "harmonic_error" };
          await sleep(1_000);
          continue;
        }
        if (!res.ok) return { ok: false, reason: "harmonic_error" };

        const body = await res.json();
        if (isMissingRecord(body))
          return { ok: false, reason: "harmonic_not_found" };
        return { ok: true, fetchedAt: new Date().toISOString(), body };
      }
    },
  };
}

// --- field picking -------------------------------------------------------------------------

export interface Evidence {
  domain: string;
  name: string;
  description: string | null;
  tags: string[];
  customerType: string | null;
  location: {
    country: string | null;
    state: string | null;
    city: string | null;
  };
  /** `YYYY-MM-DD` */
  foundingDate: string | null;
  funding: {
    stageRaw: string | null;
    totalUsd: number | null;
    roundTypes: string[];
  };
  headcount: number | null;
}

/** The fields the LLM is never allowed to touch, plus the identity ones. */
export interface HarmonicFacts {
  harmonicId?: number;
  name: string;
  logoUrl: string;
  headcount: number | null;
  totalFundingUsd: number | null;
  foundedYear: number | null;
}

function get(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const segment of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

/** First path that yields something other than `undefined`/`null`. */
export function pick(obj: unknown, paths: readonly string[]): unknown {
  for (const path of paths) {
    const value = get(obj, path);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function pickString(obj: unknown, paths: readonly string[]): string | null {
  const value = pick(obj, paths);
  if (typeof value !== "string") return null;
  return value.trim() || null;
}

function pickNumber(obj: unknown, paths: readonly string[]): number | null {
  const value = pick(obj, paths);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // Large funding totals come back as strings from some serialisers.
  if (
    typeof value === "string" &&
    value.trim() !== "" &&
    Number.isFinite(Number(value))
  ) {
    return Number(value);
  }
  return null;
}

/** `tags_v2` is an array of strings *or* of `{ type, display_value }` objects. Flatten to strings. */
function pickTags(raw: unknown): string[] {
  const value = pick(raw, ["tags_v2", "tagsV2", "tags"]);
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const tag of value) {
    if (typeof tag === "string") {
      if (tag.trim()) tags.push(tag.trim());
      continue;
    }
    const label = pickString(tag, [
      "display_value",
      "displayValue",
      "value",
      "name",
    ]);
    if (label) tags.push(label);
  }
  return [...new Set(tags)];
}

/** `customer_type` is a string or an array of strings. */
function pickCustomerType(raw: unknown): string | null {
  const value = pick(raw, ["customer_type", "customerType"]);
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const values = value.filter(
      (v): v is string => typeof v === "string" && v.trim() !== "",
    );
    return values.length ? values.join(", ") : null;
  }
  return null;
}

function pickRoundTypes(raw: unknown): string[] {
  const rounds = pick(raw, ["funding.funding_rounds", "funding.fundingRounds"]);
  if (!Array.isArray(rounds)) return [];
  const types: string[] = [];
  for (const round of rounds) {
    const type = pickString(round, [
      "funding_round_type",
      "fundingRoundType",
      "type",
    ]);
    if (type) types.push(type);
  }
  return types;
}

function pickFoundingDate(raw: unknown): string | null {
  const value = pickString(raw, [
    "founding_date.date",
    "foundingDate.date",
    "founding_date",
    "foundingDate",
  ]);
  if (!value) return null;
  const date = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function nameOf(domain: string, raw: unknown): string {
  const name = pickString(raw, ["name", "legal_name", "legalName"]);
  if (name) return name;
  const label = domain.split(".")[0]!;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function toEvidence(domain: string, raw: unknown): Evidence {
  return {
    domain,
    name: nameOf(domain, raw),
    description: pickString(raw, ["description"]),
    tags: pickTags(raw),
    customerType: pickCustomerType(raw),
    location: {
      country: pickString(raw, ["location.country", "headquarters.country"]),
      state: pickString(raw, ["location.state", "headquarters.state"]),
      city: pickString(raw, ["location.city", "headquarters.city"]),
    },
    foundingDate: pickFoundingDate(raw),
    funding: {
      stageRaw: pickString(raw, [
        "funding.funding_stage",
        "funding.fundingStage",
      ]),
      totalUsd: pickNumber(raw, [
        "funding.funding_total",
        "funding.fundingTotal",
      ]),
      roundTypes: pickRoundTypes(raw),
    },
    headcount: pickNumber(raw, [
      "headcount",
      "employee_count",
      "employeeCount",
    ]),
  };
}

export function toFacts(domain: string, raw: unknown): HarmonicFacts {
  const harmonicId = pickNumber(raw, ["id"]);
  const foundingDate = pickFoundingDate(raw);
  return {
    ...(harmonicId !== null && Number.isInteger(harmonicId)
      ? { harmonicId }
      : {}),
    name: nameOf(domain, raw),
    logoUrl:
      pickString(raw, ["logo_url", "logoUrl"]) ??
      `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
    headcount: pickNumber(raw, [
      "headcount",
      "employee_count",
      "employeeCount",
    ]),
    totalFundingUsd: pickNumber(raw, [
      "funding.funding_total",
      "funding.fundingTotal",
    ]),
    foundedYear: foundingDate ? Number(foundingDate.slice(0, 4)) : null,
  };
}
