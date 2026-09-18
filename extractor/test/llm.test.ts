import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS,
  ExtractionSchema,
  PROVIDERS,
  apiKeyFor,
  createLlmClient,
  inferProvider,
} from "../src/llm.js";

/** Nothing here reaches a provider: the network paths are exercised by a real run, not by tests. */
describe("inferProvider", () => {
  it("picks the single provider whose key is set", () => {
    expect(inferProvider({ OPENAI_API_KEY: "sk-test" })).toBe("openai");
  });

  it("accepts either name for the Gemini key", () => {
    expect(inferProvider({ GOOGLE_API_KEY: "k" })).toBe("gemini");
    expect(
      apiKeyFor("gemini", { GEMINI_API_KEY: "a", GOOGLE_API_KEY: "b" }),
    ).toBe("a");
  });

  it("refuses to guess when no key is set", () => {
    expect(() => inferProvider({})).toThrow(/none of/);
  });

  it("refuses to guess when several are set", () => {
    expect(() =>
      inferProvider({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "b" }),
    ).toThrow(/several of \(anthropic, openai\)/);
  });

  it("ignores a key that is set but empty", () => {
    expect(
      inferProvider({ ANTHROPIC_API_KEY: "  ", OPENAI_API_KEY: "sk" }),
    ).toBe("openai");
  });
});

/**
 * These really do construct the provider's chat model (no network — constructors do not call out),
 * so they also check that our options are the names the SDKs expect.
 */
describe("createLlmClient", () => {
  it("defaults to the provider's model and labels itself provider/model", async () => {
    // Against DEFAULT_MODELS, not a literal: those ids go stale and get bumped.
    for (const provider of PROVIDERS) {
      const client = await createLlmClient({ provider, apiKey: "k" });
      expect(client.label).toBe(`${provider}/${DEFAULT_MODELS[provider]}`);
    }
  });

  it("lets --model override the default", async () => {
    const openai = await createLlmClient({
      provider: "openai",
      model: "gpt-4.1",
      apiKey: "k",
    });
    expect(openai.label).toBe("openai/gpt-4.1");
  });

  it("refuses to build without a key", async () => {
    await expect(createLlmClient({ provider: "anthropic" })).rejects.toThrow(
      /no API key/,
    );
  });
});

describe("ExtractionSchema", () => {
  const valid = {
    sectors: ["Fintech"],
    businessModel: ["B2C"],
    hqCountry: "SE",
    foundedYear: 2005,
    fundingStage: "Public",
    confidence: "high",
    notes: "ok",
  };

  it("accepts a well-formed extraction", () => {
    expect(ExtractionSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    ["a lowercase country code", { hqCountry: "se" }],
    ["a country name", { hqCountry: "Sweden" }],
    ["a sector outside the taxonomy", { sectors: ["BNPL"] }],
    [
      "more than three sectors",
      { sectors: ["Fintech", "Payments", "Consumer", "Social"] },
    ],
    ["no sectors", { sectors: [] }],
    ["a stage outside the list", { fundingStage: "Series G" }],
  ])("rejects %s", (_label, override) => {
    expect(ExtractionSchema.safeParse({ ...valid, ...override }).success).toBe(
      false,
    );
  });

  it("allows a null foundedYear — that is how the model says 'I don't know'", () => {
    expect(
      ExtractionSchema.parse({ ...valid, foundedYear: null }).foundedYear,
    ).toBeNull();
  });
});
