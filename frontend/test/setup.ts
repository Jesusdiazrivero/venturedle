import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Vitest runs without globals, so Testing Library's automatic cleanup is wired up here instead.
afterEach(cleanup);

// jsdom has no canvas, and asking it for one prints a "not implemented" stack. The grid's
// flag-emoji probe measures text, so answer it with a definite "no" and get the ISO-2 fallback.
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  value: () => null,
});
