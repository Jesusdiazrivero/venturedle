import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Onboarding } from "../src/Onboarding.js";

describe("Onboarding", () => {
  it("asks for a nickname in anonymous mode", () => {
    render(<Onboarding config={{ authMode: "anonymous" }} />);

    expect(screen.getByLabelText("Nickname")).toBeDefined();
    expect(screen.getByRole("button", { name: "Play" })).toBeDefined();
    expect(document.querySelector(".google-button")).toBeNull();
  });

  it("shows the Google button and the allowed domain in google mode", () => {
    render(
      <Onboarding
        config={{
          authMode: "google",
          googleClientId: "client-123",
          googleAllowedDomain: "example.com",
        }}
      />,
    );

    expect(document.querySelector(".google-button")).not.toBeNull();
    expect(screen.queryByLabelText("Nickname")).toBeNull();
    expect(
      screen.getByText("Sign in with your @example.com account."),
    ).toBeDefined();
  });
});
