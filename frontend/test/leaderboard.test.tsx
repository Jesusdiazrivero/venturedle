import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Leaderboard as Board } from "@venturedle/shared";
import { Leaderboard } from "../src/Leaderboard.js";
import { fakeApi } from "./fake-api.js";

const board = (scope: Board["scope"], by: Board["by"]): Board => ({
  scope,
  by,
  ...(scope === "today" ? { date: "2026-10-12" } : {}),
  rows: [
    {
      rank: 1,
      player: { id: "p1", nickname: "Ada", provider: "anonymous" },
      isMe: false,
      guesses: 3,
      elapsedMs: 61_000,
    },
    {
      rank: 2,
      player: { id: "p2", nickname: "Kate", provider: "anonymous" },
      isMe: true,
      guesses: 5,
      elapsedMs: 161_000,
    },
  ],
});

const routes = {
  "GET /api/leaderboard?scope=today&by=guesses": () =>
    board("today", "guesses"),
  "GET /api/leaderboard?scope=alltime&by=guesses": () =>
    board("alltime", "guesses"),
  "GET /api/leaderboard?scope=today&by=time": () => board("today", "time"),
};

describe("Leaderboard", () => {
  it("highlights the current player's row", async () => {
    fakeApi(routes);
    render(<Leaderboard />);

    await waitFor(() => expect(screen.getByText("Kate")).toBeDefined());
    expect(screen.getByText("Kate").closest("tr")?.className).toBe("me");
    expect(screen.getByText("Ada").closest("tr")?.className).toBe("");
  });

  it("refetches with a new query string when a toggle changes", async () => {
    const api = fakeApi(routes);
    render(<Leaderboard />);

    await waitFor(() => expect(screen.getByText("Kate")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "All-time" }));
    await waitFor(() =>
      expect(api.calls).toContain(
        "GET /api/leaderboard?scope=alltime&by=guesses",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    fireEvent.click(screen.getByRole("button", { name: "Time" }));
    await waitFor(() =>
      expect(api.calls).toContain("GET /api/leaderboard?scope=today&by=time"),
    );
  });

  it("says nobody has solved it yet when today's board is empty", async () => {
    fakeApi({
      "GET /api/leaderboard?scope=today&by=guesses": () => ({
        scope: "today",
        by: "guesses",
        date: "2026-10-12",
        rows: [],
      }),
    });
    render(<Leaderboard />);

    await waitFor(() =>
      expect(
        screen.getByText(
          "Nobody has solved today's puzzle yet — be the first.",
        ),
      ).toBeDefined(),
    );
  });
});
