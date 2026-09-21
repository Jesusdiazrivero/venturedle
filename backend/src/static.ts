/**
 * In production the same process serves the API and the built SPA, so there is one origin, no CORS
 * and one container (D7). In dev `STATIC_DIR` does not exist yet and Vite serves the SPA instead,
 * proxying `/api` here.
 *
 * Cache headers are set before `serveStatic` runs rather than in its `onFound` hook: the hook fires
 * after the Response has been built, so headers set there are dropped.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import type { AppEnv } from "./config.js";

export function mountStatic(app: Hono<AppEnv>, staticDir: string): void {
  const indexHtml = path.join(staticDir, "index.html");
  if (!existsSync(indexHtml)) {
    app.get("/", (c) =>
      c.json({
        name: "venturedle",
        hint: "no built SPA here — run `npm run dev` and open the Vite server, or set STATIC_DIR",
      }),
    );
    return;
  }

  // index.html points at the hashed filenames, so it is the one file that must not be cached.
  app.use("*", (c, next) => {
    c.header("Cache-Control", "no-cache");
    return next();
  });
  // Vite content-hashes everything under `assets/`, so those can be cached forever.
  app.use("/assets/*", (c, next) => {
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    return next();
  });

  app.use("*", serveStatic({ root: staticDir }));

  // Any path that is not a real file and not `/api/*` is a client-side route. The header is reset
  // here because a *missing* hashed asset also lands on this fallback, and index.html must never be
  // cached under that name for a year.
  const fallback = serveStatic({ path: indexHtml });
  app.get("*", (c, next) => {
    c.header("Cache-Control", "no-cache");
    return fallback(c, next);
  });
}
