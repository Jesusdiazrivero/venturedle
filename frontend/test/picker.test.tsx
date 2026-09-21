import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CompanyPicker } from "../src/CompanyPicker.js";
import { POOL } from "./fixtures.js";

function renderPicker(guessedIds: string[]) {
  const onPick = vi.fn();
  render(
    <CompanyPicker
      companies={POOL}
      guessedIds={guessedIds}
      disabled={false}
      onPick={onPick}
    />,
  );
  return { onPick, input: screen.getByRole("combobox") };
}

describe("CompanyPicker", () => {
  it("hides companies that have already been guessed", () => {
    renderPicker(["klarna.com"]);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "kl" } });

    expect(screen.queryByText("Klarna")).toBeNull();
    expect(screen.getByText("Klaviyo")).toBeDefined();
  });

  it("picks the first match on Enter", () => {
    const { onPick, input } = renderPicker([]);

    fireEvent.change(input, { target: { value: "kla" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onPick).toHaveBeenCalledWith(POOL[0]);
    expect(input).toHaveProperty("value", "");
  });

  it("matches on the domain too, and moves the highlight with the arrow keys", () => {
    const { onPick, input } = renderPicker([]);

    fireEvent.change(input, { target: { value: "stripe.com" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(POOL[2]);

    fireEvent.change(input, { target: { value: "kla" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenLastCalledWith(POOL[1]);
  });
});
