"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type SearchResult = {
  id: string;
  name: string;
  domain_id?: string;
  catalog_product_id?: string;
  status?: string;
  pictures?: Array<{
    id: string;
    url: string;
  }>;
  short_description?: {
    content?: string;
  };
  sale_price?: {
    amount: number | null;
    regular_amount: number | null;
    currency_id: string | null;
    error: string | null;
  };
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

function formatCurrency(amount: number, currencyId: string) {
  try {
    return new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: currencyId,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currencyId}`;
  }
}

export default function Home() {
  const [query, setQuery] = useState<string>("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isAuthorizing, setIsAuthorizing] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
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
    const normalizedQuery = query.trim();

    if (!normalizedQuery) {
      setResults([]);
      return;
    }

    setIsSearching(true);

    try {
      const searchResponse = await fetch(
        `/api/ml/search?q=${encodeURIComponent(normalizedQuery)}&limit=50`
      );
      const searchData = await searchResponse.json().catch(() => null);

      if (!searchResponse.ok) {
        console.error("Fallo la busqueda", searchData);
        setResults([]);
        return;
      }

      const searchResults = Array.isArray(searchData) ? (searchData as SearchResult[]) : [];
      setResults(searchResults);
    } catch (error: unknown) {
      console.error("Error inesperado en la busqueda", error);
      setResults([]);
    } finally {
      setIsSearching(false);
    }
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

      <div className="flex w-full max-w-6xl gap-3 px-4">
        <input
          className="flex-1 rounded-md border border-neutral-300 px-4 py-3"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar productos"
        />

        <button
          className="rounded-md bg-black px-5 py-3 text-white disabled:cursor-not-allowed disabled:opacity-70"
          onClick={handleSearch}
          disabled={isSearching}
        >
          {isSearching ? "Buscando..." : "Buscar"}
        </button>
      </div>

      <div className="grid w-full max-w-6xl grid-cols-1 gap-4 px-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {results.map((item) => {
          const imageUrl = item.pictures?.[0]?.url;
          const description = item.short_description?.content?.trim();
          const salePrice = item.sale_price;
          const saleAmount = salePrice?.amount;
          const regularAmount = salePrice?.regular_amount;
          const currencyId = salePrice?.currency_id ?? "ARS";
          const hasSalePrice = typeof saleAmount === "number";
          const hasRegularPrice =
            typeof regularAmount === "number" && (!hasSalePrice || regularAmount > saleAmount);

          return (
            <article
              key={item.id}
              className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm"
            >
              <div className="relative flex aspect-square items-center justify-center bg-neutral-100">
                {imageUrl ? (
                  <Image
                    src={imageUrl}
                    alt={item.name}
                    fill
                    sizes="(max-width: 640px) 100vw, (max-width: 1280px) 50vw, 25vw"
                    className="object-cover"
                  />
                ) : (
                  <div className="px-6 text-center text-sm text-neutral-500">Sin imagen</div>
                )}
              </div>

              <div className="flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="line-clamp-2 text-sm font-semibold text-neutral-900">{item.name}</h2>
                  {item.status && (
                    <span className="rounded-full bg-neutral-100 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-neutral-600">
                      {item.status}
                    </span>
                  )}
                </div>

                <div className="space-y-1 text-xs text-neutral-500">
                  <p>ID: {item.id}</p>
                  {item.catalog_product_id && <p>Catalogo: {item.catalog_product_id}</p>}
                  {item.domain_id && <p>Dominio: {item.domain_id}</p>}
                </div>

                <div className="space-y-1">
                  {hasSalePrice ? (
                    <>
                      <p className="text-lg font-semibold text-neutral-900">
                        {formatCurrency(saleAmount, currencyId)}
                      </p>
                      {hasRegularPrice && (
                        <p className="text-xs text-neutral-500 line-through">
                          {formatCurrency(regularAmount, currencyId)}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-neutral-500">Precio no disponible</p>
                  )}
                </div>

                {description && <p className="line-clamp-4 text-sm text-neutral-600">{description}</p>}
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
