/**
 * The end-to-end smoke test runs against a server that is already up — `docker compose up` locally
 * (`06-deployment.md`) or a deployed box — rather than starting one itself, because pointing it at
 * production is the second half of what it is for.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
