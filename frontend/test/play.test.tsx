import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PuzzleInfo } from "@venturedle/shared";
import { Play } from "../src/Play.js";
import { fakeApi } from "./fake-api.js";
import { POOL, guess, playing } from "./fixtures.js";

const PUZZLE: PuzzleInfo = {
  date: "2026-10-12",
  exists: true,
  number: 12,
  nextPuzzleAt: "2026-10-13T00:00:00.000Z",
};

const notStarted = {
  date: "2026-10-12",
  number: 12,
  status: "not_started",
  guesses: [],
};

describe("Play", () => {
  it("starts the clock exactly once, even when the effect is run twice", async () => {
    const api = fakeApi({
      "GET /api/companies": () => POOL,
      "GET /api/results/today": () => notStarted,
      "POST /api/results/today/start": () => playing(),
    });

    // StrictMode double-invokes effects, which is exactly the double-start this guards against.
    render(
      <StrictMode>
        <Play puzzle={PUZZLE} />
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByText(/0 guesses/)).toBeDefined());
    expect(
      api.calls.filter((c) => c === "POST /api/results/today/start"),
    ).toHaveLength(1);
  });

  it("renders guesses newest first", async () => {
    fakeApi({
      "GET /api/companies": () => POOL,
      "GET /api/results/today": () =>
        playing(guess(1, POOL[0]!), guess(2, POOL[1]!)),
    });

    render(<Play puzzle={PUZZLE} />);

    await waitFor(() => expect(screen.getByText("Klaviyo")).toBeDefined());
    const names = [...document.querySelectorAll(".guess-name span")].map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["Klaviyo", "Klarna"]);
  });

  it("freezes the picker and shows the answer and the share text once solved", async () => {
    fakeApi({
      "GET /api/companies": () => POOL,
      "GET /api/results/today": () => ({
        ...playing(guess(1, POOL[0]!)),
        status: "solved",
        solvedAt: "2026-10-12T10:02:41.000Z",
        elapsedMs: 161_000,
        answer: POOL[2],
        shareText:
          "Venturedle #12 · 2026-10-12 · 1 guess · 02:41\n⬜⬜⬜⬜⬜⬜⬜",
      }),
    });

    render(<Play puzzle={PUZZLE} />);

    await waitFor(() =>
      expect(screen.getByRole("combobox")).toHaveProperty("disabled", true),
    );
    expect(screen.getByText("Stripe")).toBeDefined();
    expect(screen.getByText("Solved in 1 guess · 02:41")).toBeDefined();
    expect(document.querySelector(".share")?.textContent).toContain(
      "Venturedle #12",
    );
  });

  it("says so when nothing is scheduled, without naming the next date", async () => {
    fakeApi({});
    render(<Play puzzle={{ ...PUZZLE, exists: false, number: undefined }} />);

    expect(screen.getByText("No puzzle today")).toBeDefined();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
