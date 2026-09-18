/**
 * The only thing that talks to an LLM. It normalises categories — sectors, business model, country
 * code, funding stage — and never numbers: `totalFundingUsd` and `headcount` are not in the schema
 * at all, and `foundedYear` is only filled when Harmonic has no founding date (D3).
 *
 * LangChain is used for exactly two things: the provider factory and `withStructuredOutput`.
 */
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  BUSINESS_MODELS,
  FUNDING_STAGES,
  SECTORS,
} from "@venturedle/shared/server";
import { z } from "zod";
import type { Evidence } from "./harmonic.js";
import { AbortRunError } from "./tools.js";

export const PROVIDERS = ["anthropic", "openai", "gemini"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** These go stale. Check the provider's docs and use `--model` rather than editing for one run. */
export const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5",
  gemini: "gemini-3.1-pro",
};

/** `GEMINI_API_KEY` wins over LangChain's own `GOOGLE_API_KEY`, but both work. */
const API_KEY_ENV: Record<Provider, readonly string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

export function apiKeyFor(
  provider: Provider,
  env: NodeJS.ProcessEnv,
): string | undefined {
  for (const name of API_KEY_ENV[provider]) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * With no `--provider`, exactly one key must be set: zero is "nothing to run with", more than one
 * is a coin toss the operator should not have to guess the outcome of.
 */
export function inferProvider(env: NodeJS.ProcessEnv): Provider {
  const set = (["anthropic", "openai", "gemini"] as const).filter((p) =>
    apiKeyFor(p, env),
  );
  if (set.length === 1) return set[0]!;
  const detail =
    set.length === 0 ? "none of" : `several of (${set.join(", ")})`;
  throw new Error(
    `Could not infer --provider: ${detail} ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY is set. ` +
      `Pass --provider ${PROVIDERS.join("|")}.`,
  );
}

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
  "- Pick 1-3 sectors from the allowed list, most specific/primary first.",
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

async function createChatModel(
  provider: Provider,
  model: string,
  apiKey: string,
): Promise<BaseChatModel> {
  // Imported lazily so a run only loads the SDK of the provider it actually uses.
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
  }
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

export async function createLlmClient(options: {
  provider: Provider;
  model?: string;
  apiKey?: string;
}): Promise<LlmClient> {
  const provider = options.provider;
  const model = options.model ?? DEFAULT_MODELS[provider];
  if (!options.apiKey) throw new Error(`no API key for provider "${provider}"`);

  const chat = await createChatModel(provider, model, options.apiKey);
  const structured = chat.withStructuredOutput(RequestSchema, {
    name: "extraction",
  });

  async function ask(prompt: string): Promise<Extraction> {
    let raw: unknown;
    try {
      raw = await structured.invoke([
        ["system", SYSTEM_PROMPT],
        ["human", prompt],
      ]);
    } catch (err) {
      if (isAuthError(err)) {
        throw new AbortRunError(
          `${provider} rejected the credentials — check your API key. (${(err as Error).message})`,
        );
      }
      throw err;
    }
    // Providers occasionally lowercase or pad the country code; everything else must be exact.
    const country = (raw as { hqCountry?: unknown })?.hqCountry;
    const parsed = ExtractionSchema.safeParse(
      typeof country === "string"
        ? { ...(raw as object), hqCountry: country.trim().toUpperCase() }
        : raw,
    );
    if (!parsed.success) {
      throw new LlmInvalidOutputError(
        parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; "),
      );
    }
    return parsed.data;
  }

  return {
    label: `${provider}/${model}`,
    async extract(evidence) {
      const prompt = `Evidence:\n${JSON.stringify(evidence, null, 2)}`;
      try {
        return await ask(prompt);
      } catch (err) {
        if (!(err instanceof LlmInvalidOutputError)) throw err;
        // One retry, with the validation error appended so the model can correct itself.
        return ask(
          `${prompt}\n\nYour previous answer was rejected: ${err.message}\nReturn a corrected object.`,
        );
      }
    },
  };
}
