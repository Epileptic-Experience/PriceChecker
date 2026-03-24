import { getMeliTokenStore } from "@/lib/server/meli-token-store";
import { createMlTraceId, isMlDebugEnabled, logMlStep } from "@/lib/server/ml-debug";

type ProductSearchRawResult = {
  id?: string;
  catalog_product_id?: string;
  domain_id?: string;
  name?: string;
  status?: string;
  short_description?: {
    content?: string;
  };
  pictures?: Array<{
    id?: string;
    url?: string;
  }>;
};

type ProductSearchResponse = {
  results?: ProductSearchRawResult[];
  message?: string;
  error?: string;
  cause?: unknown;
};

type SearchResult = {
  id: string;
  name: string;
  domain_id?: string;
  catalog_product_id?: string;
  status?: string;
  short_description?: {
    content?: string;
  };
  pictures?: Array<{
    id: string;
    url: string;
  }>;
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

function readErrorDetails(data: ProductSearchResponse | null) {
  return {
    meliError: typeof data?.error === "string" ? data.error : null,
    meliMessage: typeof data?.message === "string" ? data.message : null,
    meliCause: data?.cause ?? null,
  };
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
    const accessToken = await getMeliTokenStore().getValidAccessToken();

    logMlStep({
      enabled: debugEnabled,
      route: "ml/search",
      traceId,
      step: "token_ready",
      details: { hasToken: true },
    });

    const url = new URL("https://api.mercadolibre.com/products/search");
    url.searchParams.set("q", q);
    url.searchParams.set("status", "active");
    url.searchParams.set("site_id", "MLA");
    url.searchParams.set("limit", "20");

    logMlStep({
      enabled: debugEnabled,
      route: "ml/search",
      traceId,
      step: "meli_request_started",
      details: {
        url: url.toString(),
        endpoint: "products/search",
      },
    });

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const data = (await response.json().catch(() => null)) as ProductSearchResponse | null;

    logMlStep({
      enabled: debugEnabled,
      route: "ml/search",
      traceId,
      step: "meli_request_finished",
      details: {
        status: response.status,
        ok: response.ok,
        rawResults: Array.isArray(data?.results) ? data.results.length : 0,
        endpoint: "products/search",
        ...readErrorDetails(data),
      },
    });

    if (!response.ok) {
      return Response.json(
        { error: readMeliError(data, response.status), details: readErrorDetails(data) },
        { status: response.status }
      );
    }

    const rawResults = Array.isArray(data?.results) ? data.results : [];

    const results: SearchResult[] = rawResults
      .filter((item): item is ProductSearchRawResult & { id: string } => typeof item.id === "string")
      .map((item) => ({
        id: item.id,
        name: item.name ?? item.id,
        domain_id: item.domain_id,
        catalog_product_id: item.catalog_product_id,
        status: item.status,
        short_description: item.short_description,
        pictures: Array.isArray(item.pictures)
          ? item.pictures
              .filter(
                (
                  picture
                ): picture is {
                  id: string;
                  url: string;
                } => typeof picture.id === "string" && typeof picture.url === "string"
              )
              .slice(0, 1)
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
