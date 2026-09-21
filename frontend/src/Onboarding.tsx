/**
 * What you see before you have a session token: a nickname in anonymous mode, the Google button in
 * google mode. Both end in a token, which is what `App` is waiting for.
 */
import { useState } from "react";
import type { FormEvent } from "react";
import type { AppConfig } from "@venturedle/shared";
import * as api from "./api.js";
import { ApiError } from "./api.js";
import { GoogleButton } from "./GoogleButton.js";
import { setToken } from "./session.js";

/** The two sign-in failures a player can actually do something about. */
function explain(error: unknown, allowedDomain: string | undefined): string {
  if (!(error instanceof ApiError)) return "Something went wrong. Try again.";
  if (error.code === "forbidden_domain") {
    return allowedDomain
      ? `Sign in with your @${allowedDomain} account.`
      : "That account is not allowed here.";
  }
  if (error.code === "invalid_token") return "Sign-in failed, try again.";
  if (error.code === "nickname_invalid") {
    return "Pick a nickname between 2 and 24 characters.";
  }
  return error.message || "Something went wrong. Try again.";
}

export function Onboarding({ config }: { config: AppConfig }) {
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(exchange: () => Promise<{ token: string }>) {
    setBusy(true);
    setError(null);
    try {
      setToken((await exchange()).token);
    } catch (err) {
      setError(explain(err, config.googleAllowedDomain));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void signIn(() => api.signInAnonymous(nickname));
  }

  return (
    <main className="onboarding">
      <h1>VENTUREDLE</h1>
      <p className="tagline">
        One secret startup a day. Seven columns, unlimited guesses.
      </p>

      {config.authMode === "anonymous" ? (
        <form onSubmit={onSubmit}>
          <label htmlFor="pick-nickname">Nickname</label>
          <input
            id="pick-nickname"
            value={nickname}
            maxLength={24}
            autoFocus
            onChange={(e) => setNickname(e.target.value)}
          />
          <button type="submit" disabled={busy}>
            Play
          </button>
          <p className="hint">
            No account, no email. Your progress lives in this browser — clear it
            and you are a new player.
          </p>
        </form>
      ) : (
        <>
          <GoogleButton
            clientId={config.googleClientId ?? ""}
            onCredential={(idToken) =>
              void signIn(() => api.signInGoogle(idToken))
            }
            onError={() => setError("Sign-in failed, try again.")}
          />
          {config.googleAllowedDomain ? (
            <p className="hint">
              Sign in with your @{config.googleAllowedDomain} account.
            </p>
          ) : null}
        </>
      )}

      {error ? <p className="error">{error}</p> : null}
    </main>
  );
}
