import type { ColumnDef } from "./api.js";

/**
 * The seven scored columns, in grid order — which is also the order of the emoji in each share-text
 * row. The API never sends this; the SPA imports it from the client entry point.
 */
export const COLUMN_DEFS: readonly ColumnDef[] = [
  { key: "sectors", label: "Sector", kind: "set" },
  { key: "hqCountry", label: "HQ Country", kind: "country" },
  { key: "foundedYear", label: "Founded", kind: "year" },
  { key: "fundingStage", label: "Stage", kind: "ordinal" },
  { key: "totalFundingUsd", label: "Total Funding", kind: "bucketed" },
  { key: "headcount", label: "Headcount", kind: "bucketed" },
  { key: "businessModel", label: "Model", kind: "set" },
];
