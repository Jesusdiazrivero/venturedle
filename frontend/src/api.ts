/**
 * Every call the SPA makes, typed against the DTOs in `@venturedle/shared`. Call sites do
 * `import * as api from "./api.js"`.
 *
 * `request` is the only place that knows about bearer tokens and error bodies. A 401 means the
 * session is gone (revoked, or the database was reset), so the token is cleared here and `App`
 * re-renders into Onboarding; every other non-2xx becomes an `ApiError` carrying the code from
 * docs/02-data-contract.md.
 */
import type {
  AppConfig,
  AuthResponse,
  CompanyLite,
  Leaderboard,
  PlayState,
  Player,
  PuzzleInfo,
} from "@venturedle/shared";
import { getToken, setToken } from "./session.js";

export class ApiError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "ApiError";
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await fetch(`/api${path}`, { ...init, headers });
  if (response.status === 401) {
    setToken(null);
    throw new ApiError("unauthorized");
  }
  if (response.status === 204) return undefined as T;

  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok) {
    const error = (body ?? {}) as { error?: string; message?: string };
    throw new ApiError(error.error ?? "internal", error.message);
  }
  return body as T;
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body),
});

export const getConfig = () => request<AppConfig>("/config");
export const getCompanies = () => request<CompanyLite[]>("/companies");
export const getPuzzle = () => request<PuzzleInfo>("/puzzle/today");

export const signInAnonymous = (nickname: string) =>
  request<AuthResponse>("/auth/anonymous", json({ nickname }));
export const signInGoogle = (idToken: string) =>
  request<AuthResponse>("/auth/google", json({ idToken }));
export const signOut = () =>
  request<void>("/auth/session", { method: "DELETE" });

export const getMe = () => request<Player>("/me");
export const setNickname = (nickname: string) =>
  request<Player>("/me", {
    method: "PATCH",
    body: JSON.stringify({ nickname }),
  });

export const getPlay = () => request<PlayState>("/results/today");
export const startPlay = () =>
  request<PlayState>("/results/today/start", { method: "POST" });
export const submitGuess = (companyId: string) =>
  request<PlayState>("/results/today/guesses", json({ companyId }));

export const getLeaderboard = (
  scope: Leaderboard["scope"],
  by: Leaderboard["by"],
) => request<Leaderboard>(`/leaderboard?scope=${scope}&by=${by}`);
