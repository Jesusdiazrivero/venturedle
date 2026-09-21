/**
 * The whole persistence layer: open a ready database and run plain SQL against it. No ORM, no
 * migration framework — `schema.sql` is idempotent, so opening applies it.
 *
 * `openDb` does both what `04-backend.md` called `open()` and `migrate()`: a database you have to
 * remember to migrate is a second step every caller can forget.
 */
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** Bump when `schema.sql` gains an ALTER block. */
const SCHEMA_VERSION = "1";

export type Param = SQLInputValue;

export interface Db {
  run(sql: string, ...params: Param[]): void;
  get<T>(sql: string, ...params: Param[]): T | undefined;
  all<T>(sql: string, ...params: Param[]): T[];
  /** BEGIN IMMEDIATE … COMMIT, rolling back if `fn` throws. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  db.exec(readFileSync(new URL("schema.sql", import.meta.url), "utf8"));
  db.prepare(
    "INSERT INTO meta(key, value) VALUES('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(SCHEMA_VERSION);

  return {
    run(sql, ...params) {
      db.prepare(sql).run(...params);
    },
    get<T>(sql: string, ...params: Param[]) {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    all<T>(sql: string, ...params: Param[]) {
      return db.prepare(sql).all(...params) as T[];
    },
    transaction<T>(fn: () => T): T {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    close() {
      db.close();
    },
  };
}
