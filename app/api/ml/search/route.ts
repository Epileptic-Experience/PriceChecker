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
    price?: number;
    currency_id?: string;
  } | null;
  message?: string;
  error?: string;
};

type ProductItemsResponse = {
  results?: Array<{
    item_id?: string;
    price?: number;
    currency_id?: string;
    status?: string;
  }>;
  message?: string;
  error?: string;
  cause?: unknown;
};

type ProductItemsCandidate = {
  itemId: string | null;
  price: number | null;
  currencyId: string | null;
  error: string | null;
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

type ProductResolution = {
  itemId: string | null;
  error: string | null;
  winnerPrice: number | null;
  winnerCurrency: string | null;
  itemsPrice: number | null;
  itemsCurrency: string | null;
};

type FallbackPrice = {
  amount: number;
  currencyId: string;
  source: "buy_box_winner" | "products_items" | "product_page";
};

const DEFAULT_SITE_ID = "MLA";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 50;
const DEFAULT_CONTEXT = "channel_marketplace";
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
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readAmount(value: unknown) {
  const asNumber = readNumber(value);
  if (asNumber !== null) {
    return asNumber;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().replace(/\./g, "").replace(/,/g, ".");
  if (!normalized) {
    return null;
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
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

function readPriceFromOffers(offers: unknown): { amount: number; currencyId: string } | null {
  if (Array.isArray(offers)) {
    for (const offer of offers) {
      const found = readPriceFromOffers(offer);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (typeof offers !== "object" || offers === null) {
    return null;
  }

  const entry = offers as Record<string, unknown>;
  const amount = readAmount(entry.price) ?? readAmount(entry.lowPrice) ?? readAmount(entry.highPrice);

  if (amount === null) {
    return null;
  }

  const currencyId = readString(entry.priceCurrency) ?? readString(entry.currency) ?? "ARS";

  return {
    amount,
    currencyId,
  };
}

function readPriceFromJsonLdNode(node: unknown): { amount: number; currencyId: string } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = readPriceFromJsonLdNode(child);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (typeof node !== "object" || node === null) {
    return null;
  }

  const objectNode = node as Record<string, unknown>;

  const fromOffers = readPriceFromOffers(objectNode.offers);
  if (fromOffers) {
    return fromOffers;
  }

  const fromAggregate = readPriceFromOffers(objectNode.aggregateOffer);
  if (fromAggregate) {
    return fromAggregate;
  }

  const graph = objectNode["@graph"];
  if (Array.isArray(graph)) {
    const fromGraph = readPriceFromJsonLdNode(graph);
    if (fromGraph) {
      return fromGraph;
    }
  }

  return null;
}

function readPriceFromProductHtml(html: string): { amount: number; currencyId: string } | null {
  const scriptRegex = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;

  for (const match of html.matchAll(scriptRegex)) {
    const raw = match[1]?.trim();
    if (!raw) {
      continue;
    }

    const normalized = raw.replace(/\\u002F/g, "/");

    try {
      const parsed = JSON.parse(normalized) as unknown;
      const found = readPriceFromJsonLdNode(parsed);
      if (found) {
        return found;
      }
    } catch {
      // Ignore malformed json-ld blocks.
    }
  }

  return null;
}

async function fetchProductPagePrice(productId: string) {
  const url = `https://www.mercadolibre.com.ar/p/${productId}`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "es-AR,es;q=0.9",
        "Upgrade-Insecure-Requests": "1",
      },
    });

    if (!response.ok) {
      return {
        amount: null,
        currencyId: null,
        error: `No se pudo leer la pagina del producto (HTTP ${response.status}).`,
      };
    }

    const html = await response.text();
    const extracted = readPriceFromProductHtml(html);

    if (!extracted) {
      return {
        amount: null,
        currencyId: null,
        error: "No se pudo extraer precio desde la pagina del producto.",
      };
    }

    return {
      amount: extracted.amount,
      currencyId: extracted.currencyId,
      error: null,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";

    return {
      amount: null,
      currencyId: null,
      error: `Error al consultar pagina de producto: ${message}`,
    };
  }
}

async function resolveProductToItemIdFromItems(
  productId: string,
  accessToken: string
): Promise<ProductItemsCandidate> {
  const url = new URL(`https://api.mercadolibre.com/products/${productId}/items`);
  url.searchParams.set("limit", "20");

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = (await response.json().catch(() => null)) as ProductItemsResponse | null;

  if (!response.ok) {
    return {
      itemId: null,
      price: null,
      currencyId: null,
      error:
        typeof data?.message === "string"
          ? `products/items (${response.status}): ${data.message}`
          : `products/items (HTTP ${response.status})`,
    };
  }

  const rows = Array.isArray(data?.results) ? data.results : [];
  const candidates = rows.filter(
    (row): row is { item_id: string; price?: number; currency_id?: string; status?: string } =>
      typeof row.item_id === "string"
  );

  if (candidates.length === 0) {
    return {
      itemId: null,
      price: null,
      currencyId: null,
      error: "products/items no devolvio item_id.",
    };
  }

  const preferred =
    candidates.find((row) => row.status === "active") ||
    candidates.find((row) => row.status === "paused") ||
    candidates[0];

  return {
    itemId: preferred.item_id,
    price: readNumber(preferred.price),
    currencyId: readString(preferred.currency_id),
    error: null,
  };
}

async function resolveProductToItemId(productId: string, accessToken: string): Promise<ProductResolution> {
  const url = new URL(`https://api.mercadolibre.com/products/${productId}`);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const data = (await response.json().catch(() => null)) as ProductDetailResponse | null;
  const winnerPrice = readNumber(data?.buy_box_winner?.price);
  const winnerCurrency = readString(data?.buy_box_winner?.currency_id);
  const itemId = readString(data?.buy_box_winner?.item_id);

  if (response.ok && itemId) {
    return {
      itemId,
      error: null,
      winnerPrice,
      winnerCurrency,
      itemsPrice: null,
      itemsCurrency: null,
    };
  }

  const baseError = !response.ok
    ? typeof data?.message === "string"
      ? `No se pudo resolver producto (${response.status}): ${data.message}`
      : `No se pudo resolver producto (HTTP ${response.status})`
    : "El producto no tiene buy_box_winner con item_id.";

  const fromItems = await resolveProductToItemIdFromItems(productId, accessToken);

  if (fromItems.itemId) {
    return {
      itemId: fromItems.itemId,
      error: null,
      winnerPrice,
      winnerCurrency,
      itemsPrice: fromItems.price,
      itemsCurrency: fromItems.currencyId,
    };
  }

  const combinedError = [baseError, fromItems.error].filter(Boolean).join(" | ");

  return {
    itemId: null,
    error: combinedError || "No se pudo resolver item_id desde product_id.",
    winnerPrice,
    winnerCurrency,
    itemsPrice: fromItems.price,
    itemsCurrency: fromItems.currencyId,
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

function readFallbackPrice(input: {
  winnerPrice: number | null;
  winnerCurrency: string | null;
  itemsPrice: number | null;
  itemsCurrency: string | null;
}): FallbackPrice | null {
  if (input.winnerPrice !== null) {
    return {
      amount: input.winnerPrice,
      currencyId: input.winnerCurrency || "ARS",
      source: "buy_box_winner",
    };
  }

  if (input.itemsPrice !== null) {
    return {
      amount: input.itemsPrice,
      currencyId: input.itemsCurrency || "ARS",
      source: "products_items",
    };
  }

  return null;
}

export async function GET(request: Request) {
  const debugEnabled = isMlDebugEnabled(request);
  const traceId = createMlTraceId("search");
  const startedAt = Date.now();

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();
  const siteId = (searchParams.get("site_id")?.trim() || DEFAULT_SITE_ID).toUpperCase();
  const domainId = searchParams.get("domain_id")?.trim() || DEFAULT_DOMAIN_ID;
  const context = searchParams.get("context")?.trim() || DEFAULT_CONTEXT;
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
      let winnerPrice: number | null = null;
      let winnerCurrency: string | null = null;
      let itemsPrice: number | null = null;
      let itemsCurrency: string | null = null;

      if (ITEM_ID_PATTERN.test(item.id)) {
        finalItemId = item.id;
      } else if (PRODUCT_ID_PATTERN.test(item.id)) {
        const resolved = await resolveProductToItemId(item.id, accessToken);
        winnerPrice = resolved.winnerPrice;
        winnerCurrency = resolved.winnerCurrency;
        itemsPrice = resolved.itemsPrice;
        itemsCurrency = resolved.itemsCurrency;

        if (!resolved.itemId) {
          const apiFallback = readFallbackPrice({ winnerPrice, winnerCurrency, itemsPrice, itemsCurrency });

          if (apiFallback) {
            logMlStep({
              enabled: debugEnabled,
              route: "ml/search",
              traceId,
              step: "item_price_fallback_used",
              details: {
                productId: item.id,
                source: apiFallback.source,
                reason: resolved.error,
              },
            });

            return {
              ...item,
              sale_price: {
                amount: apiFallback.amount,
                regular_amount: null,
                currency_id: apiFallback.currencyId,
                error: null,
              },
            };
          }

          const pageFallback = await fetchProductPagePrice(item.id);
          if (pageFallback.amount !== null) {
            logMlStep({
              enabled: debugEnabled,
              route: "ml/search",
              traceId,
              step: "item_price_fallback_used",
              details: {
                productId: item.id,
                source: "product_page",
                reason: resolved.error,
              },
            });

            return {
              ...item,
              sale_price: {
                amount: pageFallback.amount,
                regular_amount: null,
                currency_id: pageFallback.currencyId || "ARS",
                error: null,
              },
            };
          }

          logMlStep({
            enabled: debugEnabled,
            route: "ml/search",
            traceId,
            step: "product_resolution_failed",
            details: {
              productId: item.id,
              resolutionError: resolved.error,
              pageFallbackError: pageFallback.error,
            },
          });

          return {
            ...item,
            sale_price: {
              amount: null,
              regular_amount: null,
              currency_id: null,
              error: resolved.error ?? pageFallback.error ?? "No se pudo resolver item_id desde product_id.",
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
        const salePriceError = buildSalePriceError(salePriceData, salePriceResponse.status);

        const apiFallback = readFallbackPrice({ winnerPrice, winnerCurrency, itemsPrice, itemsCurrency });
        if (apiFallback) {
          logMlStep({
            enabled: debugEnabled,
            route: "ml/search",
            traceId,
            step: "item_price_fallback_used",
            details: {
              productId: item.id,
              itemId: finalItemId,
              source: apiFallback.source,
              reason: salePriceError,
            },
          });

          return {
            ...item,
            resolved_item_id: finalItemId,
            sale_price: {
              amount: apiFallback.amount,
              regular_amount: null,
              currency_id: apiFallback.currencyId,
              error: null,
            },
          };
        }

        const pageFallback = await fetchProductPagePrice(item.id);
        if (pageFallback.amount !== null) {
          logMlStep({
            enabled: debugEnabled,
            route: "ml/search",
            traceId,
            step: "item_price_fallback_used",
            details: {
              productId: item.id,
              itemId: finalItemId,
              source: "product_page",
              reason: salePriceError,
            },
          });

          return {
            ...item,
            resolved_item_id: finalItemId,
            sale_price: {
              amount: pageFallback.amount,
              regular_amount: null,
              currency_id: pageFallback.currencyId || "ARS",
              error: null,
            },
          };
        }

        logMlStep({
          enabled: debugEnabled,
          route: "ml/search",
          traceId,
          step: "item_price_failed",
          details: {
            productId: item.id,
            itemId: finalItemId,
            salePriceError,
            pageFallbackError: pageFallback.error,
          },
        });

        return {
          ...item,
          resolved_item_id: finalItemId,
          sale_price: {
            amount: null,
            regular_amount: null,
            currency_id: null,
            error: salePriceError,
          },
        };
      }

      const apiAmount = readNumber(salePriceData?.amount);
      const apiCurrency = readString(salePriceData?.currency_id);

      if (apiAmount !== null) {
        return {
          ...item,
          resolved_item_id: finalItemId,
          sale_price: {
            amount: apiAmount,
            regular_amount: readNumber(salePriceData?.regular_amount),
            currency_id: apiCurrency,
            error: null,
          },
        };
      }

      const apiFallback = readFallbackPrice({ winnerPrice, winnerCurrency, itemsPrice, itemsCurrency });
      if (apiFallback) {
        logMlStep({
          enabled: debugEnabled,
          route: "ml/search",
          traceId,
          step: "item_price_fallback_used",
          details: {
            productId: item.id,
            itemId: finalItemId,
            source: apiFallback.source,
            reason: "sale_price_amount_null",
          },
        });

        return {
          ...item,
          resolved_item_id: finalItemId,
          sale_price: {
            amount: apiFallback.amount,
            regular_amount: null,
            currency_id: apiFallback.currencyId,
            error: null,
          },
        };
      }

      const pageFallback = await fetchProductPagePrice(item.id);
      if (pageFallback.amount !== null) {
        logMlStep({
          enabled: debugEnabled,
          route: "ml/search",
          traceId,
          step: "item_price_fallback_used",
          details: {
            productId: item.id,
            itemId: finalItemId,
            source: "product_page",
            reason: "sale_price_amount_null",
          },
        });

        return {
          ...item,
          resolved_item_id: finalItemId,
          sale_price: {
            amount: pageFallback.amount,
            regular_amount: null,
            currency_id: pageFallback.currencyId || "ARS",
            error: null,
          },
        };
      }

      return {
        ...item,
        resolved_item_id: finalItemId,
        sale_price: {
          amount: null,
          regular_amount: null,
          currency_id: apiCurrency,
          error: "sale_price no devolvio monto para el item.",
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
