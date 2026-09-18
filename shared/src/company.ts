/**
 * The record shape shared by the extractor (writes it), the backend (reads it) and — in its
 * `CompanyLite` projection only — the SPA. `CompaniesFileSchema` is what the backend refuses to
 * start without.
 */
import { z } from "zod";
import {
  BUSINESS_MODELS,
  FUNDING_STAGES,
  SECTORS,
  type BusinessModel,
  type FundingStage,
  type Sector,
} from "./enums.js";
import { REGIONS, regionOf, type Region } from "./regions.js";

export interface CompanySource {
  harmonicId?: number;
  harmonicFetchedAt?: string;
  llm?: string;
  notes?: string;
}

export interface Company {
  /** == domain. Lowercase, no scheme, no `www.`. Stable forever. */
  id: string;
  /** the UTC date on which this company is the answer, `YYYY-MM-DD` */
  date: string;
  domain: string;
  name: string;
  logoUrl: string;
  sectors: Sector[];
  businessModel: BusinessModel[];
  /** ISO-3166-1 alpha-2, uppercase */
  hqCountry: string;
  /** derived: always `regionOf(hqCountry)` */
  region: Region;
  foundedYear: number;
  fundingStage: FundingStage;
  totalFundingUsd: number;
  headcount: number;
  source?: CompanySource;
}

/** All the SPA is ever told about a company it has not solved. */
export type CompanyLite = Pick<Company, "id" | "name" | "logoUrl">;

export interface CompaniesFile {
  version: 1;
  generatedAt: string;
  /** informational; the schedule is `company.date` */
  startDate: string;
  companies: Company[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` that is also a real calendar date — `2026-02-30` is not. */
export function isCalendarDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const CalendarDate = z.string().refine(isCalendarDate, {
  message: "must be a real calendar date in YYYY-MM-DD form",
});

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

export const CompanySourceSchema = z.object({
  harmonicId: z.number().int().optional(),
  harmonicFetchedAt: z.string().optional(),
  llm: z.string().optional(),
  notes: z.string().optional(),
});

export const CompanySchema = z
  .object({
    id: z.string().min(1),
    date: CalendarDate,
    domain: z.string().min(1),
    name: z.string().min(1),
    logoUrl: z.string().regex(/^https:\/\/\S+$/, {
      message: "must be an https:// URL",
    }),
    sectors: z.array(z.enum(SECTORS)).min(1).max(3),
    businessModel: z
      .array(z.enum(BUSINESS_MODELS))
      .min(1)
      .max(BUSINESS_MODELS.length),
    hqCountry: z.string().regex(/^[A-Z]{2}$/, {
      message: "must be an uppercase ISO-3166-1 alpha-2 code",
    }),
    region: z.enum(REGIONS),
    foundedYear: z.number().int().min(1800).max(new Date().getUTCFullYear()),
    totalFundingUsd: z.number().int().nonnegative(),
    headcount: z.number().int().nonnegative(),
    fundingStage: z.enum(FUNDING_STAGES),
    source: CompanySourceSchema.optional(),
  })
  .superRefine((c, ctx) => {
    if (c.region !== regionOf(c.hqCountry)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["region"],
        message: `region must be regionOf(${c.hqCountry}) = "${regionOf(c.hqCountry)}"`,
      });
    }
    if (hasDuplicates(c.sectors)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sectors"],
        message: "must not repeat a sector",
      });
    }
    if (hasDuplicates(c.businessModel)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["businessModel"],
        message: "must not repeat a business model",
      });
    }
  });

export const CompaniesFileSchema = z
  .object({
    version: z.literal(1),
    generatedAt: z.string().min(1),
    startDate: CalendarDate,
    companies: z.array(CompanySchema).min(1),
  })
  .superRefine((file, ctx) => {
    const seenIds = new Map<string, number>();
    const seenDates = new Map<string, number>();
    file.companies.forEach((c, i) => {
      const firstId = seenIds.get(c.id);
      if (firstId !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["companies", i, "id"],
          message: `duplicate id "${c.id}" (first seen at index ${firstId})`,
        });
      } else {
        seenIds.set(c.id, i);
      }

      const firstDate = seenDates.get(c.date);
      if (firstDate !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["companies", i, "date"],
          message: `duplicate date "${c.date}" (first seen at index ${firstDate})`,
        });
      } else {
        seenDates.set(c.date, i);
      }

      // Sorted ascending, so puzzleNumber = index + 1 is meaningful. Gaps are allowed.
      const prev = file.companies[i - 1];
      if (prev && prev.date >= c.date) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["companies", i, "date"],
          message: `companies must be sorted by date ascending ("${c.date}" follows "${prev.date}")`,
        });
      }
    });
  });

/** Narrowing helper the extractor and the backend both use when reading the file. */
export function parseCompaniesFile(value: unknown): CompaniesFile {
  return CompaniesFileSchema.parse(value) as CompaniesFile;
}

export function toCompanyLite(c: Company): CompanyLite {
  return { id: c.id, name: c.name, logoUrl: c.logoUrl };
}
