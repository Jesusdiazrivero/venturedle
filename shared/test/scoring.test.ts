import { describe, expect, it } from "vitest";
import type { ColumnKey } from "../src/api.js";
import { COLUMN_DEFS } from "../src/columns.js";
import { evaluateGuess } from "../src/scoring.js";
import { ANSWER, guess } from "./fixtures.js";

function cell(result: ReturnType<typeof evaluateGuess>, column: ColumnKey) {
  const c = result.cells.find((x) => x.column === column);
  if (!c) throw new Error(`no cell for ${column}`);
  return c;
}

describe("evaluateGuess: shape", () => {
  it("returns one cell per column, in COLUMN_DEFS order", () => {
    const r = evaluateGuess(guess(), ANSWER);
    expect(r.cells.map((c) => c.column)).toEqual(COLUMN_DEFS.map((d) => d.key));
  });
});

describe("evaluateGuess: sectors (set)", () => {
  it("green on identical set", () => {
    const r = evaluateGuess(
      guess({ sectors: ["Fintech", "Payments"] }),
      ANSWER,
    );
    expect(cell(r, "sectors").color).toBe("green");
  });
  it("green regardless of order", () => {
    const r = evaluateGuess(
      guess({ sectors: ["Payments", "Fintech"] }),
      ANSWER,
    );
    expect(cell(r, "sectors").color).toBe("green");
  });
  it("yellow on non-empty intersection", () => {
    const r = evaluateGuess(guess({ sectors: ["Fintech", "AI / ML"] }), ANSWER);
    expect(cell(r, "sectors").color).toBe("yellow");
  });
  it("grey on disjoint sets", () => {
    const r = evaluateGuess(guess({ sectors: ["Gaming"] }), ANSWER);
    expect(cell(r, "sectors").color).toBe("grey");
  });
  it("displays the guess's own sectors, joined", () => {
    const r = evaluateGuess(guess({ sectors: ["Gaming", "Consumer"] }), ANSWER);
    expect(cell(r, "sectors").displayValue).toBe("Gaming, Consumer");
  });
});

describe("evaluateGuess: hqCountry", () => {
  it("green on same country", () => {
    const r = evaluateGuess(
      guess({ hqCountry: "ES", region: "Europe" }),
      ANSWER,
    );
    expect(cell(r, "hqCountry").color).toBe("green");
  });
  it("yellow on same region, different country", () => {
    const r = evaluateGuess(
      guess({ hqCountry: "FR", region: "Europe" }),
      ANSWER,
    );
    expect(cell(r, "hqCountry").color).toBe("yellow");
  });
  it("grey on different region", () => {
    const r = evaluateGuess(
      guess({ hqCountry: "US", region: "North America" }),
      ANSWER,
    );
    expect(cell(r, "hqCountry").color).toBe("grey");
  });
  it("displays the ISO-2 code, not a name", () => {
    const r = evaluateGuess(
      guess({ hqCountry: "US", region: "North America" }),
      ANSWER,
    );
    expect(cell(r, "hqCountry").displayValue).toBe("US");
  });
});

describe("evaluateGuess: foundedYear", () => {
  it("green on equal, with no direction", () => {
    const c = cell(
      evaluateGuess(guess({ foundedYear: 2015 }), ANSWER),
      "foundedYear",
    );
    expect(c.color).toBe("green");
    expect(c.direction).toBeUndefined();
  });
  it("grey with 'higher' when the guess is older", () => {
    const c = cell(
      evaluateGuess(guess({ foundedYear: 2010 }), ANSWER),
      "foundedYear",
    );
    expect(c.color).toBe("grey");
    expect(c.direction).toBe("higher");
  });
  it("grey with 'lower' when the guess is younger", () => {
    const c = cell(
      evaluateGuess(guess({ foundedYear: 2020 }), ANSWER),
      "foundedYear",
    );
    expect(c.color).toBe("grey");
    expect(c.direction).toBe("lower");
  });
  it("is never yellow", () => {
    for (const y of [1990, 2014, 2015, 2016, 2026]) {
      expect(
        cell(evaluateGuess(guess({ foundedYear: y }), ANSWER), "foundedYear")
          .color,
      ).not.toBe("yellow");
    }
  });
});

describe("evaluateGuess: fundingStage (ordinal)", () => {
  it("green on the same stage, with no direction", () => {
    const c = cell(
      evaluateGuess(guess({ fundingStage: "Series B" }), ANSWER),
      "fundingStage",
    );
    expect(c.color).toBe("green");
    expect(c.direction).toBeUndefined();
  });
  it("yellow one step below, pointing higher", () => {
    const c = cell(
      evaluateGuess(guess({ fundingStage: "Series A" }), ANSWER),
      "fundingStage",
    );
    expect(c.color).toBe("yellow");
    expect(c.direction).toBe("higher");
  });
  it("yellow one step above, pointing lower", () => {
    const c = cell(
      evaluateGuess(guess({ fundingStage: "Series C" }), ANSWER),
      "fundingStage",
    );
    expect(c.color).toBe("yellow");
    expect(c.direction).toBe("lower");
  });
  it("grey two steps below, pointing higher", () => {
    const c = cell(
      evaluateGuess(guess({ fundingStage: "Seed" }), ANSWER),
      "fundingStage",
    );
    expect(c.color).toBe("grey");
    expect(c.direction).toBe("higher");
  });
  it("grey several steps above, pointing lower", () => {
    const c = cell(
      evaluateGuess(guess({ fundingStage: "Public" }), ANSWER),
      "fundingStage",
    );
    expect(c.color).toBe("grey");
    expect(c.direction).toBe("lower");
  });

  // v2 addition: adjacency at both ends of the list.
  it("Seed against a Pre-seed answer is yellow (bottom edge)", () => {
    const answer = { ...ANSWER, fundingStage: "Pre-seed" as const };
    const c = cell(
      evaluateGuess(guess({ fundingStage: "Seed" }), answer),
      "fundingStage",
    );
    expect(c.color).toBe("yellow");
    expect(c.direction).toBe("lower");
  });
  it("Acquired against a Public answer is yellow, pointing back down (top edge)", () => {
    const answer = { ...ANSWER, fundingStage: "Public" as const };
    const c = cell(
      evaluateGuess(guess({ fundingStage: "Acquired" }), answer),
      "fundingStage",
    );
    expect(c.color).toBe("yellow");
    expect(c.direction).toBe("lower");
  });
  it("Pre-seed against an Acquired answer is grey, the whole list apart", () => {
    const answer = { ...ANSWER, fundingStage: "Acquired" as const };
    const c = cell(
      evaluateGuess(guess({ fundingStage: "Pre-seed" }), answer),
      "fundingStage",
    );
    expect(c.color).toBe("grey");
    expect(c.direction).toBe("higher");
  });
});

describe("evaluateGuess: totalFundingUsd (bucketed)", () => {
  it("green in the same bucket (answer is in $25M–$100M)", () => {
    expect(
      cell(
        evaluateGuess(guess({ totalFundingUsd: 50_000_000 }), ANSWER),
        "totalFundingUsd",
      ).color,
    ).toBe("green");
  });
  it("grey pointing higher when the guess's bucket is below", () => {
    const c = cell(
      evaluateGuess(guess({ totalFundingUsd: 3_000_000 }), ANSWER),
      "totalFundingUsd",
    );
    expect(c.color).toBe("grey");
    expect(c.direction).toBe("higher");
  });
  it("grey pointing lower when the guess's bucket is above", () => {
    const c = cell(
      evaluateGuess(guess({ totalFundingUsd: 700_000_000 }), ANSWER),
      "totalFundingUsd",
    );
    expect(c.color).toBe("grey");
    expect(c.direction).toBe("lower");
  });
  it("shows the bucket label, never the number", () => {
    const c = cell(
      evaluateGuess(guess({ totalFundingUsd: 31_337_042 }), ANSWER),
      "totalFundingUsd",
    );
    expect(c.displayValue).toBe("$25M–$100M");
    expect(c.displayValue).not.toMatch(/31/);
  });
});

describe("evaluateGuess: headcount (bucketed)", () => {
  it("green in the same bucket (answer 150 → 51–200)", () => {
    expect(
      cell(evaluateGuess(guess({ headcount: 100 }), ANSWER), "headcount").color,
    ).toBe("green");
  });
  it("grey pointing higher when the guess's bucket is below", () => {
    const c = cell(
      evaluateGuess(guess({ headcount: 30 }), ANSWER),
      "headcount",
    );
    expect(c.color).toBe("grey");
    expect(c.direction).toBe("higher");
  });
  it("grey pointing lower when the guess's bucket is above", () => {
    const c = cell(
      evaluateGuess(guess({ headcount: 2000 }), ANSWER),
      "headcount",
    );
    expect(c.color).toBe("grey");
    expect(c.direction).toBe("lower");
  });
  it("shows the bucket label, never the number", () => {
    const c = cell(
      evaluateGuess(guess({ headcount: 187 }), ANSWER),
      "headcount",
    );
    expect(c.displayValue).toBe("51–200");
  });
});

describe("evaluateGuess: businessModel (set)", () => {
  it("green on identical set", () => {
    expect(
      cell(
        evaluateGuess(guess({ businessModel: ["B2B"] }), ANSWER),
        "businessModel",
      ).color,
    ).toBe("green");
  });
  it("yellow on intersection", () => {
    expect(
      cell(
        evaluateGuess(guess({ businessModel: ["B2B", "B2C"] }), ANSWER),
        "businessModel",
      ).color,
    ).toBe("yellow");
  });
  it("grey on disjoint", () => {
    expect(
      cell(
        evaluateGuess(guess({ businessModel: ["B2C"] }), ANSWER),
        "businessModel",
      ).color,
    ).toBe("grey");
  });
});

describe("evaluateGuess: correct", () => {
  it("is true only when the ids match", () => {
    const r = evaluateGuess({ ...ANSWER }, ANSWER);
    expect(r.correct).toBe(true);
    expect(r.cells.every((c) => c.color === "green")).toBe(true);
  });
  it("is false when any cell differs", () => {
    expect(evaluateGuess(guess({ foundedYear: 2014 }), ANSWER).correct).toBe(
      false,
    );
  });

  // v2 change: two companies can share a seven-tuple, so all-green is not a win on its own.
  it("is false for a different company with an identical seven-tuple, though every cell is green", () => {
    const twin = guess(); // same seven fields, different id
    const r = evaluateGuess(twin, ANSWER);
    expect(r.cells.every((c) => c.color === "green")).toBe(true);
    expect(r.correct).toBe(false);
  });
  it("ignores fields outside the seven columns", () => {
    const sameCompanyDifferentMetadata = {
      ...ANSWER,
      name: "Renamed Co",
      logoUrl: "https://example.com/other.png",
      date: "2026-12-31",
    };
    expect(evaluateGuess(sameCompanyDifferentMetadata, ANSWER).correct).toBe(
      true,
    );
  });
});
