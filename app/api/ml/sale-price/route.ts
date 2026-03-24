import { getMeliTokenStore } from "@/lib/server/meli-token-store";
import { createMlTraceId, isMlDebugEnabled, logMlStep } from "@/lib/server/ml-debug";

type SalePricePayload = {
  item_ids?: string[];
  context?: string;
};

type MercadoLibreSalePrice = {
  price_id?: string;
  amount?: number;
  regular_amount?: number;
  currency_id?: string;
  reference_date?: string;
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

type SalePriceResult = {
  item_id: string;
  amount: number | null;
  regular_amount: number | null;
  currency_id: string | null;
  price_id: string | null;
  reference_date: string | null;
  error: string | null;
};

const DEFAULT_CONTEXT = "channel_marketplace,buyer_loyalty_3";
const ITEM_ID_PATTERN = /^[A-Z]{3}\d{9,}$/;
const PRODUCT_ID_PATTERN = /^[A-Z]{3}\d{7,}$/;

function normalizeItemIds(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim())
        .filter(Boolean)
    )
  );
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

function buildMeliError(data: MercadoLibreSalePrice | null, status: number) {
  const details = [
    readString(data?.error),
    readString(data?.message),
    readCause(data?.cause),
  ].filter((value): value is string => Boolean(value));

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

export async function POST(request: Request) {
  const debugEnabled = isMlDebugEnabled(request);
  const traceId = createMlTraceId("sale-price");
  const startedAt = Date.now();

  let payload: SalePricePayload;

  logMlStep({
    enabled: debugEnabled,
    route: "ml/sale-price",
    traceId,
    step: "request_started",
  });

  try {
    payload = (await request.json()) as SalePricePayload;
  } catch {
    logMlStep({
      enabled: debugEnabled,
      route: "ml/sale-price",
      traceId,
      step: "invalid_json",
    });
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const itemIds = normalizeItemIds(payload.item_ids);

  if (itemIds.length === 0) {
    logMlStep({
      enabled: debugEnabled,
      route: "ml/sale-price",
      traceId,
      step: "validation_failed",
      details: { reason: "missing_item_ids" },
    });

    return Response.json(
      { error: 'Missing "item_ids" array in request body' },
      { status: 400 }
    );
  }

  const context =
    readString(payload.context)?.trim() || process.env.ML_SALE_PRICE_CONTEXT || DEFAULT_CONTEXT;

  logMlStep({
    enabled: debugEnabled,
    route: "ml/sale-price",
    traceId,
    step: "payload_ready",
    details: {
      itemCount: itemIds.length,
      context,
    },
  });

  try {
    const accessToken = await getMeliTokenStore().getValidAccessToken();

    logMlStep({
      enabled: debugEnabled,
      route: "ml/sale-price",
      traceId,
      step: "token_ready",
      details: { hasToken: Boolean(accessToken) },
    });

    const results = await Promise.all(
      itemIds.map(async (inputId): Promise<SalePriceResult> => {
        let finalItemId = inputId;

        if (!ITEM_ID_PATTERN.test(inputId)) {
          if (!PRODUCT_ID_PATTERN.test(inputId)) {
            return {
              item_id: inputId,
              amount: null,
              regular_amount: null,
              currency_id: null,
              price_id: null,
              reference_date: null,
              error: "ID invalido para item/producto.",
            };
          }

          const resolved = await resolveProductToItemId(inputId, accessToken);

          logMlStep({
            enabled: debugEnabled,
            route: "ml/sale-price",
            traceId,
            step: "product_resolution",
            details: {
              productId: inputId,
              resolvedItemId: resolved.itemId,
              resolutionError: resolved.error,
            },
          });

          if (!resolved.itemId) {
            return {
              item_id: inputId,
              amount: null,
              regular_amount: null,
              currency_id: null,
              price_id: null,
              reference_date: null,
              error: resolved.error ?? "No se pudo resolver item_id desde product_id.",
            };
          }

          finalItemId = resolved.itemId;
        }

        const url = new URL(`https://api.mercadolibre.com/items/${finalItemId}/sale_price`);
        if (context) {
          url.searchParams.set("context", context);
        }

        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        const data = (await response.json().catch(() => null)) as MercadoLibreSalePrice | null;

        if (!response.ok) {
          logMlStep({
            enabled: debugEnabled,
            route: "ml/sale-price",
            traceId,
            step: "item_request_failed",
            details: {
              inputId,
              finalItemId,
              status: response.status,
            },
          });

          return {
            item_id: inputId,
            amount: null,
            regular_amount: null,
            currency_id: null,
            price_id: null,
            reference_date: null,
            error: buildMeliError(data, response.status),
          };
        }

        logMlStep({
          enabled: debugEnabled,
          route: "ml/sale-price",
          traceId,
          step: "item_request_ok",
          details: {
            inputId,
            finalItemId,
            hasAmount: typeof data?.amount === "number",
          },
        });

        return {
          item_id: inputId,
          amount: readNumber(data?.amount),
          regular_amount: readNumber(data?.regular_amount),
          currency_id: readString(data?.currency_id),
          price_id: readString(data?.price_id),
          reference_date: readString(data?.reference_date),
          error: null,
        };
      })
    );

    const successCount = results.filter((item) => item.error === null).length;

    logMlStep({
      enabled: debugEnabled,
      route: "ml/sale-price",
      traceId,
      step: "response_ready",
      details: {
        total: results.length,
        successCount,
        errorCount: results.length - successCount,
      },
    });

    return Response.json({ context, results });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";

    logMlStep({
      enabled: debugEnabled,
      route: "ml/sale-price",
      traceId,
      step: "request_failed",
      details: { message },
    });

    return Response.json({ error: message }, { status: 500 });
  } finally {
    logMlStep({
      enabled: debugEnabled,
      route: "ml/sale-price",
      traceId,
      step: "request_finished",
      details: {
        durationMs: Date.now() - startedAt,
      },
    });
  }
}
