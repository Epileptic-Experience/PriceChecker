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

type ProductDetailResponse = {
  id?: string;
  buy_box_winner?: {
    item_id?: string;
  } | null;
  message?: string;
  error?: string;
};

type MercadoLibreSalePrice = {
  amount?: number;
  regular_amount?: number;
  currency_id?: string;
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
  sale_price?: {
    amount: number | null;
    regular_amount: number | null;
    currency_id: string | null;
    error: string | null;
  };
  resolved_item_id?: string;
};

const DEFAULT_SITE_ID = "MLA";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;
const DEFAULT_CONTEXT = "channel_marketplace,buyer_loyalty_3";
const DEFAULT_DOMAIN_ID = process.env.ML_SEARCH_DEFAULT_DOMAIN_ID || "MLA-CELLPHONES";
const ITEM_ID_PATTERN = /^[A-Z]{3}\d{9,}$/;
const PRODUCT_ID_PATTERN = /^[A-Z]{3}\d{7,}$/;

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

function readString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown) {
  return typeof value === "number" ? value : null;
}

function readCause(cause: unknown) {
  if (!Array.isArray(cause)) {
    return null;
  }

  const normalized = cause
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }

      if (typeof entry !== "object" || entry === null) {
        return null;
      }

      const code = "code" in entry && typeof entry.code === "string" ? entry.code : null;
      const message = "message" in entry && typeof entry.message === "string" ? entry.message : null;

      return [code, message].filter(Boolean).join(": ");
    })
    .filter((entry): entry is string => Boolean(entry));

  return normalized.length > 0 ? normalized.join(" | ") : null;
}

function buildSalePriceError(data: MercadoLibreSalePrice | null, status: number) {
  const details = [readString(data?.error), readString(data?.message), readCause(data?.cause)].filter(
    (value): value is string => Boolean(value)
  );

  if (details.length === 0) {
    return `MercadoLibre request failed (HTTP ${status}).`;
  }

  return `HTTP ${status}: ${details.join(" - ")}`;
}

async function resolveProductToItemId(productId: string, accessToken: string) {
  const url = new URL(`https://api.mercadolibre.com/products/${productId}`);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = (await response.json().catch(() => null)) as ProductDetailResponse | null;

  if (!response.ok) {
    return {
      itemId: null,
      error:
        typeof data?.message === "string"
          ? `No se pudo resolver producto (${response.status}): ${data.message}`
          : `No se pudo resolver producto (HTTP ${response.status})`,
    };
  }

  const itemId = readString(data?.buy_box_winner?.item_id);

  if (!itemId) {
    return {
      itemId: null,
      error: "El producto no tiene buy_box_winner con item_id.",
    };
  }

  return {
    itemId,
    error: null,
  };
}

async function mapWithConcurrency<T, R>(values: T[], limit: number, worker: (value: T) => Promise<R>) {
  if (values.length === 0) {
    return [] as R[];
  }

  const safeLimit = Math.max(1, Math.min(limit, values.length));
  const results = new Array<R>(values.length);
  let index = 0;

  const runners = Array.from({ length: safeLimit }, async () => {
    while (true) {
      const currentIndex = index;
      index += 1;

      if (currentIndex >= values.length) {
        return;
      }

      results[currentIndex] = await worker(values[currentIndex]);
    }
  });

  await Promise.all(runners);
  return results;
}

export async function GET(request: Request) {
  const debugEnabled = isMlDebugEnabled(request);
  const traceId = createMlTraceId("search");
  const startedAt = Date.now();

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();
  const siteId = (searchParams.get("site_id")?.trim() || DEFAULT_SITE_ID).toUpperCase();
  const domainId = searchParams.get("domain_id")?.trim() || DEFAULT_DOMAIN_ID;
  const context = searchParams.get("context")?.trim() || process.env.ML_SALE_PRICE_CONTEXT || DEFAULT_CONTEXT;
  const includePrices = searchParams.get("include_prices") !== "false";
  const requestedLimit = Number.parseInt(searchParams.get("limit") || "", 10);
  const limit = Number.isNaN(requestedLimit)
    ? DEFAULT_LIMIT
    : Math.max(1, Math.min(MAX_LIMIT, requestedLimit));

  logMlStep({
    enabled: debugEnabled,
    route: "ml/search",
    traceId,
    step: "request_started",
    details: {
      query: q ?? null,
      siteId,
      domainId,
      limit,
      includePrices,
      context,
    },
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
    url.searchParams.set("site_id", siteId);
    url.searchParams.set("limit", String(limit));

    if (domainId) {
      url.searchParams.set("domain_id", domainId);
    }

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

    const baseResults: SearchResult[] = rawResults
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

    if (!includePrices || baseResults.length === 0) {
      logMlStep({
        enabled: debugEnabled,
        route: "ml/search",
        traceId,
        step: "response_ready",
        details: { results: baseResults.length, priced: false },
      });

      return Response.json(baseResults);
    }

    logMlStep({
      enabled: debugEnabled,
      route: "ml/search",
      traceId,
      step: "price_enrichment_started",
      details: { total: baseResults.length },
    });

    const enrichedResults = await mapWithConcurrency(baseResults, 8, async (item) => {
      let finalItemId: string | null = null;

      if (ITEM_ID_PATTERN.test(item.id)) {
        finalItemId = item.id;
      } else if (PRODUCT_ID_PATTERN.test(item.id)) {
        const resolved = await resolveProductToItemId(item.id, accessToken);

        if (!resolved.itemId) {
          logMlStep({
            enabled: debugEnabled,
            route: "ml/search",
            traceId,
            step: "product_resolution_failed",
            details: {
              productId: item.id,
              error: resolved.error,
            },
          });

          return {
            ...item,
            sale_price: {
              amount: null,
              regular_amount: null,
              currency_id: null,
              error: resolved.error ?? "No se pudo resolver item_id desde product_id.",
            },
          };
        }

        finalItemId = resolved.itemId;
      } else {
        return {
          ...item,
          sale_price: {
            amount: null,
            regular_amount: null,
            currency_id: null,
            error: "ID invalido para item/producto.",
          },
        };
      }

      const salePriceUrl = new URL(`https://api.mercadolibre.com/items/${finalItemId}/sale_price`);
      salePriceUrl.searchParams.set("context", context);

      const salePriceResponse = await fetch(salePriceUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const salePriceData = (await salePriceResponse.json().catch(() => null)) as
        | MercadoLibreSalePrice
        | null;

      if (!salePriceResponse.ok) {
        const error = buildSalePriceError(salePriceData, salePriceResponse.status);

        logMlStep({
          enabled: debugEnabled,
          route: "ml/search",
          traceId,
          step: "item_price_failed",
          details: {
            productId: item.id,
            itemId: finalItemId,
            status: salePriceResponse.status,
            error,
          },
        });

        return {
          ...item,
          resolved_item_id: finalItemId,
          sale_price: {
            amount: null,
            regular_amount: null,
            currency_id: null,
            error,
          },
        };
      }

      return {
        ...item,
        resolved_item_id: finalItemId,
        sale_price: {
          amount: readNumber(salePriceData?.amount),
          regular_amount: readNumber(salePriceData?.regular_amount),
          currency_id: readString(salePriceData?.currency_id),
          error: null,
        },
      };
    });

    const withPrice = enrichedResults.filter((item) => typeof item.sale_price?.amount === "number").length;

    logMlStep({
      enabled: debugEnabled,
      route: "ml/search",
      traceId,
      step: "price_enrichment_finished",
      details: {
        total: enrichedResults.length,
        withPrice,
        withoutPrice: enrichedResults.length - withPrice,
      },
    });

    logMlStep({
      enabled: debugEnabled,
      route: "ml/search",
      traceId,
      step: "response_ready",
      details: { results: enrichedResults.length, priced: true },
    });

    return Response.json(enrichedResults);
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
