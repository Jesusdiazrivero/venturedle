/**
 * The Google Identity Services button. The script is fetched on demand — anonymous deployments
 * never touch accounts.google.com — and the client id comes from `GET /api/config`, so one build
 * works for every deployment.
 */
import { useEffect, useRef } from "react";

const SCRIPT_SRC = "https://accounts.google.com/gsi/client";

interface GoogleIdentity {
  accounts: {
    id: {
      initialize(options: {
        client_id: string;
        callback: (response: { credential: string }) => void;
      }): void;
      renderButton(parent: HTMLElement, options: Record<string, string>): void;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleIdentity;
  }
}

function loadScript(): Promise<GoogleIdentity> {
  const existing = document.querySelector<HTMLScriptElement>(
    `script[src="${SCRIPT_SRC}"]`,
  );
  const script = existing ?? document.createElement("script");
  const ready = new Promise<GoogleIdentity>((resolve, reject) => {
    if (window.google) return resolve(window.google);
    script.addEventListener("load", () => {
      if (window.google) resolve(window.google);
      else reject(new Error("google identity services did not load"));
    });
    script.addEventListener("error", () =>
      reject(new Error("google identity services did not load")),
    );
  });
  if (!existing) {
    script.src = SCRIPT_SRC;
    script.async = true;
    document.head.append(script);
  }
  return ready;
}

export function GoogleButton({
  clientId,
  onCredential,
  onError,
}: {
  clientId: string;
  onCredential: (idToken: string) => void;
  onError: (message: string) => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  // The callback must not re-initialise GIS every render, and GIS keeps the first one it is given.
  const callback = useRef(onCredential);
  callback.current = onCredential;
  const failed = useRef(onError);
  failed.current = onError;

  useEffect(() => {
    let cancelled = false;
    loadScript()
      .then((google) => {
        if (cancelled || !mount.current) return;
        google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => callback.current(response.credential),
        });
        google.accounts.id.renderButton(mount.current, {
          theme: "outline",
          size: "large",
          text: "signin_with",
        });
      })
      .catch((err: Error) => {
        if (!cancelled) failed.current(err.message);
      });
    return () => {
      cancelled = true;
    };
    // Only the client id can change what GIS renders; the callbacks are read through refs.
  }, [clientId]);

  return <div ref={mount} className="google-button" />;
}
