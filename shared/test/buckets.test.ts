import { describe, expect, it } from "vitest";
import { FUNDING_BUCKETS, HEADCOUNT_BUCKETS, bucketOf } from "../src/enums.js";

describe("bucket tables", () => {
  it.each([
    ["FUNDING_BUCKETS", FUNDING_BUCKETS],
    ["HEADCOUNT_BUCKETS", HEADCOUNT_BUCKETS],
  ])("%s edges are disjoint and contiguous", (_name, buckets) => {
    expect(buckets[0]!.min).toBe(0);
    expect(buckets[buckets.length - 1]!.max).toBe(Infinity);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i]!.min).toBe(buckets[i - 1]!.max + 1);
      expect(buckets[i]!.index).toBe(i);
    }
  });
});

describe("bucketOf: funding edges", () => {
  it.each([
    [0, 0, "<$1M"],
    [999_999, 0, "<$1M"],
    [1_000_000, 1, "$1M–$5M"],
    [4_999_999, 1, "$1M–$5M"],
    [5_000_000, 2, "$5M–$25M"],
    [24_999_999, 2, "$5M–$25M"],
    [25_000_000, 3, "$25M–$100M"],
    [99_999_999, 3, "$25M–$100M"],
    [100_000_000, 4, "$100M–$500M"],
    [499_999_999, 4, "$100M–$500M"],
    [500_000_000, 5, "$500M–$1B"],
    [999_999_999, 5, "$500M–$1B"],
    [1_000_000_000, 6, ">$1B"],
    [98_000_000_000, 6, ">$1B"],
  ])("%d → bucket %d (%s)", (value, index, label) => {
    const b = bucketOf(value, FUNDING_BUCKETS);
    expect(b.index).toBe(index);
    expect(b.label).toBe(label);
  });
});

describe("bucketOf: headcount edges", () => {
  it.each([
    [0, 0],
    [1, 0],
    [10, 0],
    [11, 1],
    [50, 1],
    [51, 2],
    [200, 2],
    [201, 3],
    [500, 3],
    [501, 4],
    [1_000, 4],
    [1_001, 5],
    [5_000, 5],
    [5_001, 6],
    [250_000, 6],
  ])("%d → bucket %d", (value, index) => {
    expect(bucketOf(value, HEADCOUNT_BUCKETS).index).toBe(index);
  });
});

describe("bucketOf: totality", () => {
  it("puts every non-negative integer around every funding edge in exactly one bucket", () => {
    const edges = FUNDING_BUCKETS.flatMap((b) => [b.min - 1, b.min, b.min + 1]);
    for (const v of [0, ...edges].filter((v) => v >= 0 && Number.isFinite(v))) {
      const matches = FUNDING_BUCKETS.filter((b) => v >= b.min && v <= b.max);
      expect(matches, `value ${v}`).toHaveLength(1);
      expect(bucketOf(v, FUNDING_BUCKETS)).toBe(matches[0]);
    }
  });

  it("puts every headcount from 0 to 6,000 in exactly one bucket", () => {
    for (let v = 0; v <= 6_000; v++) {
      const matches = HEADCOUNT_BUCKETS.filter((b) => v >= b.min && v <= b.max);
      expect(matches, `value ${v}`).toHaveLength(1);
      expect(bucketOf(v, HEADCOUNT_BUCKETS)).toBe(matches[0]);
    }
  });

  it("clamps a negative value to the first bucket rather than falling through to the last", () => {
    expect(bucketOf(-1, FUNDING_BUCKETS).index).toBe(0);
    expect(bucketOf(-1, HEADCOUNT_BUCKETS).index).toBe(0);
  });
});
