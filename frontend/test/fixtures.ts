import { COLUMN_DEFS } from "@venturedle/shared";
import type { CompanyLite, GuessResult, PlayState } from "@venturedle/shared";

export const POOL: CompanyLite[] = [
  { id: "klarna.com", name: "Klarna", logoUrl: "https://x/klarna.png" },
  { id: "klaviyo.com", name: "Klaviyo", logoUrl: "https://x/klaviyo.png" },
  { id: "stripe.com", name: "Stripe", logoUrl: "https://x/stripe.png" },
];

export function guess(seq: number, company: CompanyLite): GuessResult {
  return {
    seq,
    guess: company,
    cells: COLUMN_DEFS.map((column) => ({
      column: column.key,
      color: "grey" as const,
      displayValue: column.key === "hqCountry" ? "SE" : `${column.key}-value`,
    })),
    correct: false,
    at: "2026-10-12T10:0" + seq + ":00.000Z",
  };
}

export function playing(...guesses: GuessResult[]): PlayState {
  return {
    date: "2026-10-12",
    number: 12,
    status: "playing",
    startedAt: "2026-10-12T10:00:00.000Z",
    guesses,
  };
}
