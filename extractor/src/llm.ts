/**
 * The only thing that talks to an LLM. It normalises categories — sectors, business model, country
 * code, funding stage — and never numbers: `totalFundingUsd` and `headcount` are not in the schema
 * at all, and `foundedYear` is only filled when Harmonic has no founding date (D3).
 *
 * LangChain is used for exactly two things: the provider factory and `withStructuredOutput`.
 */
import { createHash } from "node:crypto";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  BUSINESS_MODELS,
  FUNDING_STAGES,
  SECTORS,
} from "@venturedle/shared/server";
import { z } from "zod";
import { createCache, type Cache } from "./cache.js";
import { countryCodeOf } from "./countries.js";
import type { Evidence } from "./evidence.js";
import { hashDomain } from "./harmonic.js";
import { DEFAULT_MODELS, type Provider } from "./models.js";
import { AbortRunError } from "./types.js";

/** What we accept back. `hqCountry` is re-checked here even though the prompt asks for ISO-2. */
export const ExtractionSchema = z.object({
  sectors: z.array(z.enum(SECTORS)).min(1).max(3),
  businessModel: z.array(z.enum(BUSINESS_MODELS)).min(1),
  hqCountry: z.string().regex(/^[A-Z]{2}$/),
  foundedYear: z.number().int().nullable(),
  fundingStage: z.enum(FUNDING_STAGES),
  confidence: z.enum(["high", "medium", "low"]),
  notes: z.string().max(300),
});
export type Extraction = z.infer<typeof ExtractionSchema>;

/**
 * What we *ask* for. Deliberately looser than `ExtractionSchema`: `withStructuredOutput` compiles
 * this to each provider's native tool/JSON schema and they disagree about `pattern`, so the regex
 * lives only in the post-validation above.
 */
const RequestSchema = z.object({
  sectors: z
    .array(z.enum(SECTORS))
    .min(1)
    .max(3)
    .describe("1–3 sectors, most specific/primary first"),
  businessModel: z.array(z.enum(BUSINESS_MODELS)).min(1),
  hqCountry: z.string().length(2).describe("ISO-3166-1 alpha-2, uppercase"),
  foundedYear: z
    .number()
    .int()
    .nullable()
    .describe("echo Harmonic's year, or fill it if missing; null if unsure"),
  fundingStage: z.enum(FUNDING_STAGES),
  confidence: z.enum(["high", "medium", "low"]),
  notes: z
    .string()
    .describe("one line: why, especially for the stage and sector calls"),
});

export const SYSTEM_PROMPT = [
  "You normalise startup data for a guessing game. Given evidence about one company, return the fields in the schema.",
  "Rules:",
  "- Pick 1–3 sectors from the allowed list, most specific/primary first.",
  "- Never invent numbers.",
  "- Map the HQ country name to its ISO-3166-1 alpha-2 code, uppercase.",
  "- Map the funding stage: PRE_SEED→Pre-seed; SEED→Seed; SERIES_A/B/C→Series A/B/C;",
  "  SERIES_D or later, or LATER_STAGE/PRIVATE_EQUITY with at least Series C history→Series D+;",
  "  EXITED→Public if the round types include IPO/PUBLIC_EQUITY_OFFERING or the description says it is listed,",
  "  otherwise Acquired; unknown or other→best judgement from the description and the funding total, and say so in notes.",
  "- Business model: B2B, B2C, B2B2C and/or Marketplace — a company can be several.",
  "- foundedYear: echo the year of the evidence's foundingDate when it is present. Fill it only when it is missing",
  "  and the description or your own knowledge makes you confident; otherwise return null.",
].join("\n");

/** Changing the taxonomy or the prompt must invalidate every cached extraction. */
const SCHEMA_FINGERPRINT = JSON.stringify({
  sectors: SECTORS,
  businessModel: BUSINESS_MODELS,
  fundingStage: FUNDING_STAGES,
  fields: Object.keys(RequestSchema.shape),
});

export class LlmInvalidOutputError extends Error {
  constructor(detail: string) {
    super(`llm_invalid_output: ${detail}`);
    this.name = "LlmInvalidOutputError";
  }
}

export interface LlmClient {
  /** `${provider}/${model}`, stored in `source.llm` */
  readonly label: string;
  extract(evidence: Evidence): Promise<Extraction>;
}

/** Just enough of LangChain's runnable to invoke it; the result is re-validated anyway. */
interface StructuredRunnable {
  invoke(input: unknown): Promise<unknown>;
}

export interface LlmOptions {
  provider: Provider;
  model?: string;
  apiKey?: string;
  cacheDir?: string | null;
}

function humanPrompt(evidence: Evidence): string {
  return `Evidence:\n${JSON.stringify(evidence, null, 2)}`;
}

function cacheKey(domain: string, label: string, prompt: string): string {
  const hash = createHash("sha256")
    .update(`${SYSTEM_PROMPT}\n${prompt}\n${SCHEMA_FINGERPRINT}\n${label}`)
    .digest("hex")
    .slice(0, 12);
  return `llm/${domain}.${hash}.json`;
}

function isAuthError(err: unknown): boolean {
  const status =
    (err as { status?: number; statusCode?: number })?.status ??
    (err as { statusCode?: number })?.statusCode;
  if (status === 401 || status === 403) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /\b(401|403)\b|invalid[_ ]api[_ ]key|authentication|unauthorized|permission denied/i.test(
    message,
  );
}

async function createChatModel(
  provider: Provider,
  model: string,
  apiKey: string,
): Promise<BaseChatModel> {
  // Imported lazily so an offline `--provider mock` run never loads a provider SDK.
  switch (provider) {
    case "anthropic": {
      const { ChatAnthropic } = await import("@langchain/anthropic");
      return new ChatAnthropic({ apiKey, model, temperature: 0 });
    }
    case "openai": {
      const { ChatOpenAI } = await import("@langchain/openai");
      return new ChatOpenAI({ apiKey, model, temperature: 0 });
    }
    case "gemini": {
      const { ChatGoogleGenerativeAI } =
        await import("@langchain/google-genai");
      return new ChatGoogleGenerativeAI({ apiKey, model, temperature: 0 });
    }
    case "mock":
      throw new Error("the mock provider has no chat model");
  }
}

export function createLlmClient(options: LlmOptions): LlmClient {
  if (options.provider === "mock") return createMockLlmClient();

  const model = options.model ?? DEFAULT_MODELS[options.provider];
  const label = `${options.provider}/${model}`;
  const cache: Cache = createCache(options.cacheDir ?? null);
  if (!options.apiKey)
    throw new Error(`no API key for provider "${options.provider}"`);
  const apiKey: string = options.apiKey;

  let structured: Promise<StructuredRunnable> | undefined;
  function chain(): Promise<StructuredRunnable> {
    structured ??= createChatModel(options.provider, model, apiKey).then((m) =>
      m.withStructuredOutput(RequestSchema, { name: "extraction" }),
    );
    return structured;
  }

  async function ask(prompt: string): Promise<Extraction> {
    let raw: unknown;
    try {
      raw = await (
        await chain()
      ).invoke([
        ["system", SYSTEM_PROMPT],
        ["human", prompt],
      ]);
    } catch (err) {
      if (isAuthError(err)) {
        throw new AbortRunError(
          `${options.provider} rejected the credentials — check your API key. (${(err as Error).message})`,
        );
      }
      throw err;
    }
    const parsed = ExtractionSchema.safeParse(normaliseRaw(raw));
    if (!parsed.success)
      throw new LlmInvalidOutputError(
        parsed.error.issues.map(issueLine).join("; "),
      );
    return parsed.data;
  }

  return {
    label,
    async extract(evidence) {
      const prompt = humanPrompt(evidence);
      const key = cacheKey(evidence.domain, label, prompt);
      const cached = await cache.read<Extraction>(key);
      if (cached) {
        const parsed = ExtractionSchema.safeParse(cached);
        if (parsed.success) return parsed.data;
      }

      let extraction: Extraction;
      try {
        extraction = await ask(prompt);
      } catch (err) {
        if (!(err instanceof LlmInvalidOutputError)) throw err;
        // One retry, with the validation error appended so the model can correct itself.
        extraction = await ask(
          `${prompt}\n\nYour previous answer was rejected: ${err.message}\nReturn a corrected object.`,
        );
      }
      await cache.write(key, extraction);
      return extraction;
    },
  };
}

function issueLine(issue: z.ZodIssue): string {
  return `${issue.path.join(".") || "(root)"}: ${issue.message}`;
}

/** Providers occasionally uppercase or pad the country code; everything else must be exact. */
function normaliseRaw(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.hqCountry === "string") {
    return { ...obj, hqCountry: obj.hqCountry.trim().toUpperCase() };
  }
  return obj;
}

// --- mock provider -------------------------------------------------------------------------

const MOCK_COUNTRIES = ["US", "GB", "DE", "ES", "SE", "SG", "BR"];

/**
 * The documented stage mapping, applied deterministically. The real providers are asked to do this
 * in the prompt; the mock does it in code so offline runs produce sensible, stable records.
 */
export function mapFundingStage(
  evidence: Evidence,
): (typeof FUNDING_STAGES)[number] {
  const raw = (evidence.funding.stageRaw ?? "").toUpperCase();
  const rounds = evidence.funding.roundTypes.map((r) => r.toUpperCase());
  const wentPublic = rounds.some(
    (r) => r === "IPO" || r === "PUBLIC_EQUITY_OFFERING",
  );
  switch (raw) {
    case "PRE_SEED":
      return "Pre-seed";
    case "SEED":
      return "Seed";
    case "SERIES_A":
      return "Series A";
    case "SERIES_B":
      return "Series B";
    case "SERIES_C":
      return "Series C";
    case "EXITED":
      return wentPublic ? "Public" : "Acquired";
    case "":
      break;
    default:
      return "Series D+"; // SERIES_D and later, LATER_STAGE, PRIVATE_EQUITY
  }
  const total = evidence.funding.totalUsd ?? 0;
  if (total >= 100_000_000) return "Series D+";
  if (total >= 25_000_000) return "Series C";
  if (total >= 5_000_000) return "Series A";
  return "Seed";
}

function mockSectors(evidence: Evidence, h: number): Extraction["sectors"] {
  const known = evidence.tags.filter((tag): tag is (typeof SECTORS)[number] =>
    (SECTORS as readonly string[]).includes(tag),
  );
  const picked = [...new Set(known)].slice(0, 3);
  return picked.length ? picked : [SECTORS[h % SECTORS.length]!];
}

function mockBusinessModel(
  evidence: Evidence,
  h: number,
): Extraction["businessModel"] {
  const declared = (evidence.customerType ?? "")
    .split(/[,/]/)
    .map((v) => v.trim().toUpperCase())
    .filter((v): v is (typeof BUSINESS_MODELS)[number] =>
      (BUSINESS_MODELS as readonly string[]).includes(v),
    );
  return declared.length
    ? [...new Set(declared)]
    : [BUSINESS_MODELS[h % BUSINESS_MODELS.length]!];
}

/** Offline and deterministic: the same evidence always yields the same extraction. */
export function createMockLlmClient(): LlmClient {
  return {
    label: "mock/mock",
    async extract(evidence) {
      const h = hashDomain(evidence.domain);
      return {
        sectors: mockSectors(evidence, h),
        businessModel: mockBusinessModel(evidence, h),
        hqCountry:
          countryCodeOf(evidence.location.country) ??
          MOCK_COUNTRIES[h % MOCK_COUNTRIES.length]!,
        foundedYear: evidence.foundingDate
          ? Number(evidence.foundingDate.slice(0, 4))
          : 2015,
        fundingStage: mapFundingStage(evidence),
        confidence: "high",
        notes:
          "mock provider — categories derived deterministically from the evidence, not from a model",
      };
    },
  };
}
