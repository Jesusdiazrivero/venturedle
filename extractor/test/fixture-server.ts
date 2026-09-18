/**
 * A stand-in for `api.harmonic.ai`: serves `test/fixtures/harmonic/{domain}.json` and 404s for
 * anything else. Tests point `HARMONIC_BASE_URL` at it; nothing in this workspace ever calls the
 * real API.
 */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "harmonic",
);

export interface FixtureServer {
  url: string;
  /** requests received since the last `reset()` */
  requests: string[];
  reset(): void;
  close(): Promise<void>;
}

export interface FixtureServerOptions {
  /** status codes to return before serving normally, e.g. [429, 429] */
  failWith?: number[];
  fixtureDir?: string;
}

export async function startFixtureServer(
  options: FixtureServerOptions = {},
): Promise<FixtureServer> {
  const dir = options.fixtureDir ?? FIXTURE_DIR;
  const failures = [...(options.failWith ?? [])];
  let requests: string[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const domain = url.searchParams.get("website_domain") ?? "";
    requests.push(domain);

    const failure = failures.shift();
    if (failure !== undefined) {
      res.writeHead(failure, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `forced ${failure}` }));
      return;
    }

    readFile(path.join(dir, `${domain}.json`), "utf8").then(
      (body) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      },
      () => {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      },
    );
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("could not bind fixture server");

  return {
    url: `http://127.0.0.1:${address.port}`,
    get requests() {
      return requests;
    },
    reset() {
      requests = [];
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
