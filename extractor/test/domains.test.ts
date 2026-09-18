import { describe, expect, it } from "vitest";
import { isDomain, normaliseDomain, parseDomainsFile } from "../src/domains.js";

describe("normaliseDomain", () => {
  it.each([
    ["klarna.com", "klarna.com"],
    ["  Klarna.COM  ", "klarna.com"],
    ["www.n26.com", "n26.com"],
    ["https://getmonzo.co.uk/about", "getmonzo.co.uk"],
    ["http://www.Revolut.com:8080/x?y=1#z", "revolut.com"],
    ["stripe.com.", "stripe.com"],
    ["klarna.com   # the Swedish one", "klarna.com"],
  ])("%s → %s", (raw, expected) => {
    expect(normaliseDomain(raw)).toBe(expected);
  });

  it.each(["", "   ", "# a comment", "  # indented comment"])(
    "returns null for %o",
    (raw) => {
      expect(normaliseDomain(raw)).toBeNull();
    },
  );
});

describe("isDomain", () => {
  it.each(["klarna.com", "getmonzo.co.uk", "acme-nodata.io", "a.b"])(
    "accepts %s",
    (value) => {
      expect(isDomain(value)).toBe(true);
    },
  );

  it.each([
    "klarna",
    "not a domain",
    "-klarna.com",
    "klarna-.com",
    "klarna..com",
  ])("rejects %o", (value) => {
    expect(isDomain(value)).toBe(false);
  });
});

describe("parseDomainsFile", () => {
  it("skips blanks and comments and keeps input order", () => {
    const entries = parseDomainsFile(
      [
        "# October",
        "klarna.com",
        "",
        "  ",
        "https://www.revolut.com/about",
        "n26.com",
      ].join("\n"),
    );
    expect(entries.map((e) => e.domain)).toEqual([
      "klarna.com",
      "revolut.com",
      "n26.com",
    ]);
    expect(entries.map((e) => e.line)).toEqual([2, 5, 6]);
  });

  it("rejects a duplicate that only appears after normalisation", () => {
    expect(() =>
      parseDomainsFile("klarna.com\nhttps://www.Klarna.com/eu\n"),
    ).toThrow(/line 2: duplicate domain "klarna.com" \(first seen on line 1\)/);
  });

  it("rejects a line that is not a domain", () => {
    expect(() => parseDomainsFile("klarna.com\nthe swedish one\n")).toThrow(
      /line 2/,
    );
  });

  it("rejects an empty file", () => {
    expect(() => parseDomainsFile("# nothing here\n")).toThrow(/no domains/);
  });
});
