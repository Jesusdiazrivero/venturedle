/**
 * A disk cache so re-running the extractor after fixing one domain costs nothing. Both caches keep
 * the *raw* payload: a wrong field mapping can then be corrected offline, without refetching.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface Cache {
  /** `key` is a path relative to the cache root, e.g. `harmonic/klarna.com.json`. */
  read<T>(key: string): Promise<T | undefined>;
  write(key: string, value: unknown): Promise<void>;
}

const noopCache: Cache = {
  async read() {
    return undefined;
  },
  async write() {},
};

export function createCache(dir: string | null): Cache {
  if (dir === null) return noopCache;
  return {
    async read<T>(key: string): Promise<T | undefined> {
      try {
        return JSON.parse(await readFile(path.join(dir, key), "utf8")) as T;
      } catch {
        return undefined; // a missing or corrupt entry is just a miss
      }
    },
    async write(key, value) {
      const file = path.join(dir, key);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
    },
  };
}
