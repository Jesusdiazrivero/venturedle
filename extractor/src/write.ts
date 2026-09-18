/**
 * Writes the two outputs. `companies.json` is pretty-printed with a trailing newline because it is
 * meant to be diffed and hand-edited — it is the schedule *and* the answer key.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  CompaniesFileSchema,
  type CompaniesFile,
  type Company,
} from "@venturedle/shared/server";
import type { Rejection } from "./types.js";

export function buildCompaniesFile(
  companies: Company[],
  startDate: string,
  generatedAt: string,
): CompaniesFile {
  const file: CompaniesFile = { version: 1, generatedAt, startDate, companies };
  CompaniesFileSchema.parse(file); // never write a file the backend would refuse to start on
  return file;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeCompaniesFile(
  file: string,
  data: CompaniesFile,
): Promise<void> {
  await writeJson(file, data);
}

/** Written next to `--out`, and written even when empty so a stale list never misleads. */
export function rejectedPathFor(outFile: string): string {
  return path.join(path.dirname(outFile), "rejected.json");
}

export async function writeRejected(
  file: string,
  rejected: readonly Rejection[],
): Promise<void> {
  await writeJson(file, rejected);
}
