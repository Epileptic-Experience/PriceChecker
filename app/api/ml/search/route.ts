import { getMeliTokenStore } from "@/lib/server/meli-token-store";
import { createMlTraceId, isMlDebugEnabled, logMlStep } from "@/lib/server/ml-debug";

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
};

type SiteSearchRawResult = {
  id?: string;
  title?: string;
  domain_id?: string;
  catalog_product_id?: string;
  status?: string;
  thumbnail?: string;
};

type SiteSearchResponse = {
  results?: SiteSearchRawResult[];
  message?: string;
  error?: string;
  cause?: unknown;
};

function readMeliError(data: unknown, status: number) {
  if (typeof data !== "object" || data === null) {
    return `MercadoLibre request failed (HTTP ${status}).`;
  }

  const message = "message" in data && typeof data.message === "string" ? data.message : null;
  const error = "error" in data && typeof data.error === "string" ? data.error : null;

  const details = [error, message].filter(Boolean).join(" - ");
  return details ? `HTTP ${status}: ${details}` : `MercadoLibre request failed (HTTP ${status}).`;
}

function readErrorDetails(data: SiteSearchResponse | null) {
  return {
    meliError: typeof data?.error === "string" ? data.error : null,
    meliMessage: typeof data?.message === "string" ? data.message : null,
    meliCause: data?.cause ?? null,
  };
}

async function fetchSiteSearch(url: URL, accessToken?: string) {
  const headers: HeadersInit | undefined = accessToken
    ? {
        Authorization: `Bearer ${accessToken}`,
      }
    : undefined;

  const response = await fetch(url, { headers });
  const data = (await response.json().catch(() => null)) as SiteSearchResponse | null;

  return { response, data };
}

export async function GET(request: Request) {
  const debugEnabled = isMlDebugEnabled(request);
  const traceId = createMlTraceId("search");
  const startedAt = Date.now();

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();

  logMlStep({
    enabled: debugEnabled,
    route: "ml/search",
    traceId,
    step: "request_started",
    details: { query: q ?? null },
  });

  if (!q) {
    logMlStep({
      enabled: debugEnabled,
      route: "ml/search",
      traceId,
      step: "validation_failed",
      details: { reason: "missing_query" },
    });
    return Response.json({ error: "Missing query" }, { status: 400 });
  }

  try {
    let accessToken: string | undefined;

    try {
      accessToken = await getMeliTokenStore().getValidAccessToken();
      logMlStep({
        enabled: debugEnabled,
        route: "ml/search",
        traceId,
        step: "token_ready",
        details: { hasToken: true },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logMlStep({
        enabled: debugEnabled,
        route: "ml/search",
        traceId,
        step: "token_unavailable",
        details: { message },
      });
    }

    const url = new URL("https://api.mercadolibre.com/sites/MLA/search");
    url.searchParams.set("q", q);
    url.searchParams.set("status", "active");
    url.searchParams.set("limit", "20");

    logMlStep({
      enabled: debugEnabled,
      route: "ml/search",
      traceId,
      step: "meli_request_started",
      details: {
        url: url.toString(),
        authMode: accessToken ? "bearer" : "public",
      },
    });

    let { response, data } = await fetchSiteSearch(url, accessToken);

    logMlStep({
      enabled: debugEnabled,
      route: "ml/search",
      traceId,
      step: "meli_request_finished",
      details: {
        status: response.status,
        ok: response.ok,
        authMode: accessToken ? "bearer" : "public",
        rawResults: Array.isArray(data?.results) ? data.results.length : 0,
        ...readErrorDetails(data),
      },
    });

    if (response.status === 403 && accessToken) {
      logMlStep({
        enabled: debugEnabled,
        route: "ml/search",
        traceId,
        step: "fallback_public_search_started",
      });

      const fallback = await fetchSiteSearch(url);
      response = fallback.response;
      data = fallback.data;

      logMlStep({
        enabled: debugEnabled,
        route: "ml/search",
        traceId,
        step: "fallback_public_search_finished",
        details: {
          status: response.status,
          ok: response.ok,
          authMode: "public",
          rawResults: Array.isArray(data?.results) ? data.results.length : 0,
          ...readErrorDetails(data),
        },
      });
    }

    if (!response.ok) {
      return Response.json(
        { error: readMeliError(data, response.status), details: readErrorDetails(data) },
        { status: response.status }
      );
    }

    const rawResults = Array.isArray(data?.results) ? data.results : [];

    const results: SearchResult[] = rawResults
      .filter((item): item is SiteSearchRawResult & { id: string } => typeof item.id === "string")
      .map((item) => ({
        id: item.id,
        name: item.title ?? item.id,
        domain_id: item.domain_id,
        catalog_product_id: item.catalog_product_id,
        status: item.status,
        pictures: item.thumbnail
          ? [
              {
                id: `${item.id}-thumb`,
                url: item.thumbnail,
              },
            ]
          : undefined,
      }));

    logMlStep({
      enabled: debugEnabled,
      route: "ml/search",
      traceId,
      step: "response_ready",
      details: { results: results.length },
    });

    return Response.json(results);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";

    logMlStep({
      enabled: debugEnabled,
      route: "ml/search",
      traceId,
      step: "request_failed",
      details: { message },
    });

    return Response.json({ error: message }, { status: 500 });
  } finally {
    logMlStep({
      enabled: debugEnabled,
      route: "ml/search",
      traceId,
      step: "request_finished",
      details: {
        durationMs: Date.now() - startedAt,
      },
    });
  }
}
