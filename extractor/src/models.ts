/**
 * Default model per provider. These go stale — check the provider's docs and use `--model` to
 * override rather than editing this file for a one-off run.
 */
export const PROVIDERS = ["anthropic", "openai", "gemini", "mock"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5",
  gemini: "gemini-2.5-pro",
  mock: "mock",
};

/** Env var holding each provider's key. `GEMINI_API_KEY` wins over LangChain's `GOOGLE_API_KEY`. */
export const API_KEY_ENV: Record<
  Exclude<Provider, "mock">,
  readonly string[]
> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

export function apiKeyFor(
  provider: Exclude<Provider, "mock">,
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
export function inferProvider(
  env: NodeJS.ProcessEnv,
): Exclude<Provider, "mock"> {
  const set = (["anthropic", "openai", "gemini"] as const).filter((p) =>
    apiKeyFor(p, env),
  );
  if (set.length === 1) return set[0]!;
  const detail =
    set.length === 0 ? "none of" : `several of (${set.join(", ")})`;
  throw new Error(
    `Could not infer --provider: ${detail} ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY is set. ` +
      `Pass --provider anthropic|openai|gemini|mock.`,
  );
}
