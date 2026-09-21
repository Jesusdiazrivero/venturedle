/**
 * One real game in a real browser against a running deployment: anonymous player → wrong guess →
 * the answer → share text. It is `backend/scripts/smoke.sh` with a UI, and like that script it
 * reads the answer from the schedule file, which is why this is a smoke test and not a game:
 *
 *   cd deploy && DOMAIN=:80 docker compose up -d --build
 *   npm run test:e2e
 *   E2E_BASE_URL=https://venturedle.example.com npm run test:e2e     # against a deployed box
 *
 * `COMPANIES_FILE` must be the schedule that server is serving (default `data/companies.json`).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { PuzzleInfo } from "@venturedle/shared";

interface ScheduledCompany {
  id: string;
  name: string;
  date: string;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const scheduleFile = resolve(
  root,
  process.env.COMPANIES_FILE ?? "data/companies.json",
);

function scheduleFor(date: string): {
  answer: ScheduledCompany;
  other: ScheduledCompany;
} {
  const { companies } = JSON.parse(readFileSync(scheduleFile, "utf8")) as {
    companies: ScheduledCompany[];
  };
  const answer = companies.find((company) => company.date === date);
  const other = companies.find((company) => company.date !== date);
  if (!answer || !other) {
    throw new Error(`${scheduleFile} has no puzzle on ${date} to play against`);
  }
  return { answer, other };
}

/** The picker matches on the domain too, and domains are unique — names need not be. */
async function guess(page: Page, company: ScheduledCompany) {
  const picker = page.getByRole("combobox", { name: "Guess a company" });
  await picker.fill(company.id);
  await expect(page.getByRole("option", { name: company.name })).toBeVisible();
  await picker.press("Enter");
}

test("a new player signs in, solves today's puzzle and gets the share text", async ({
  page,
  request,
}) => {
  const nickname = `smoke-${process.pid}`;
  const puzzle = (await (
    await request.get("/api/puzzle/today")
  ).json()) as PuzzleInfo;
  expect(puzzle.exists, `nothing scheduled for ${puzzle.date} UTC`).toBe(true);
  const { answer, other } = scheduleFor(puzzle.date);

  await page.goto("/");
  await page.getByLabel("Nickname").fill(nickname);
  await page.getByRole("button", { name: "Play" }).click();

  await guess(page, other);
  await expect(page.locator(".grid-row")).toHaveCount(1);
  await expect(page.locator(".win")).toHaveCount(0);

  await guess(page, answer);
  await expect(page.locator(".win")).toBeVisible();
  await expect(page.locator(".win h2")).toHaveText(answer.name);

  const share = await page.locator("pre.share").innerText();
  expect(share).toContain(
    `Venturedle #${puzzle.number} · ${puzzle.date} · 2 guesses`,
  );
  expect(share).toContain("🟩".repeat(7));

  // The solve is on the board other players see, not only in this tab.
  await page.getByRole("link", { name: "See leaderboard" }).click();
  await expect(page.locator("tr.me")).toContainText(nickname);
});
