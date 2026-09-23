/**
 * A `fetch` double: routes keyed by `"<METHOD> <path>"`, each returning the JSON body (or a whole
 * `Response` for the error cases). An unrouted request fails the test rather than returning
 * something plausible.
 */
import { vi } from "vitest";

type Handler = (body: unknown) => unknown;

export interface FakeApi {
  /** `"<METHOD> <path>"` for every request made, in order. */
  calls: string[];
}

export function fakeApi(routes: Record<string, Handler>): FakeApi {
  const calls: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${url}`;
      calls.push(key);
      const handler = routes[key];
      if (!handler) throw new Error(`unexpected request: ${key}`);
      const value = handler(
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      );
      if (value instanceof Response) return value;
      return new Response(JSON.stringify(value), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );

  return { calls };
}

export function failWith(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
