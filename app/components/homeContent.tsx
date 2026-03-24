"use client"
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type SearchResult = {
  id: string;
  title: string;
};

const PKCE_VERIFIER_KEY = "meli_pkce_verifier";
const OAUTH_STATE_KEY = "meli_oauth_state";

function encodeBase64Url(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createCodeVerifier() {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  return encodeBase64Url(randomBytes.buffer);
}

async function createCodeChallenge(codeVerifier: string) {
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return encodeBase64Url(digest);
}


export default function Home() {
  const [query, setQuery] = useState<string>("")
  const [results, setResults] = useState<SearchResult[]>([])
  const [authError, setAuthError] = useState<string | null>(null);
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  useEffect(() => {
    if (!code) {
      return;
    }

    const storedState = window.sessionStorage.getItem(OAUTH_STATE_KEY);
    const codeVerifier = window.sessionStorage.getItem(PKCE_VERIFIER_KEY);

    if (!codeVerifier) {
      setAuthError("No se encontro el code_verifier para completar la autorizacion.");
      return;
    }

    if (!state || !storedState || state !== storedState) {
      setAuthError("El state de autorizacion no coincide.");
      return;
    }

    const exchangeCode = async () => {
      setIsAuthorizing(true);
      setAuthError(null);

      try {
        const res = await fetch("/api/ml/auth", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            code,
            code_verifier: codeVerifier,
          }),
        });

        const data = await res.json().catch(() => null);

        if (!res.ok) {
          const message =
            typeof data?.error?.message === "string"
              ? data.error.message
              : typeof data?.error === "string"
                ? data.error
                : "No se pudo completar la autorizacion.";
          throw new Error(message);
        }

        window.sessionStorage.removeItem(PKCE_VERIFIER_KEY);
        window.sessionStorage.removeItem(OAUTH_STATE_KEY);
        router.replace("/");
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Error desconocido";
        setAuthError(message);
      } finally {
        setIsAuthorizing(false);
      }
    };

    void exchangeCode();
  }, [code, router, state]);

  const handleSearch = async () => {
    const res = await fetch(`/api/ml/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (!res.ok) {
      console.error("Fallo la busqueda", data);
      return;
    }
    setResults(data);
  };

  const handleLogin = () => {
    const startLogin = async () => {
      const codeVerifier = createCodeVerifier();
      const codeChallenge = await createCodeChallenge(codeVerifier);
      const oauthState = crypto.randomUUID();

      window.sessionStorage.setItem(PKCE_VERIFIER_KEY, codeVerifier);
      window.sessionStorage.setItem(OAUTH_STATE_KEY, oauthState);

      const client_id = process.env.NEXT_PUBLIC_CLIENT_ID;
      const redirect_uri = process.env.NEXT_PUBLIC_REDIRECT_URI;
      const url = new URL("https://auth.mercadolibre.com.ar/authorization");

      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", client_id ?? "");
      url.searchParams.set("redirect_uri", redirect_uri ?? "");
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("state", oauthState);

      window.location.href = url.toString();
    };

    void startLogin();
  };

  return (
    <div className="flex flex-col items-center justify-center gap-4">
      <button onClick={handleLogin}>Conectar MercadoLibre</button>

      {isAuthorizing && <p>Autorizando con MercadoLibre...</p>}
      {authError && <p>{authError}</p>}

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Buscar"
      />

      <button onClick={handleSearch}>Buscar</button>

      <div>
        {results.map((item, idx) => (
          <div key={idx}>
            {item.title}
          </div>
        ))}
      </div>
    </div>
  );
}
