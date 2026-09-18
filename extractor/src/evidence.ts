/**
 * Raw Harmonic response → the two things the rest of the pipeline needs: the numbers we copy
 * verbatim (`HarmonicFacts`) and the compact, LLM-facing `Evidence`.
 *
 * Field picking is deliberately tolerant: the REST API is believed to return snake_case and the
 * MCP layer returns camelCase, so every accessor accepts both. `docs/03-extractor.md` has the
 * table of intents; this file is its implementation.
 */

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
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
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
  const logoUrl = pickString(raw, ["logo_url", "logoUrl"]);
  return {
    ...(harmonicId !== null && Number.isInteger(harmonicId)
      ? { harmonicId }
      : {}),
    name: nameOf(domain, raw),
    logoUrl:
      logoUrl ?? `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
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
