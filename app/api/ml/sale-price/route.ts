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

function invalidItemResult(itemId: string): SalePriceResult {
  return {
    item_id: itemId,
    amount: null,
    regular_amount: null,
    currency_id: null,
    price_id: null,
    reference_date: null,
    error:
      "Invalid ITEM_ID for /items/{id}/sale_price. Esperado formato de publicacion (ej: MLA1234567890), no ID de catalogo/producto.",
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
      itemIds.map(async (itemId): Promise<SalePriceResult> => {
        if (!ITEM_ID_PATTERN.test(itemId)) {
          logMlStep({
            enabled: debugEnabled,
            route: "ml/sale-price",
            traceId,
            step: "item_skipped_invalid_id",
            details: { itemId },
          });
          return invalidItemResult(itemId);
        }

        const url = new URL(`https://api.mercadolibre.com/items/${itemId}/sale_price`);
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
              itemId,
              status: response.status,
            },
          });

          return {
            item_id: itemId,
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
            itemId,
            hasAmount: typeof data?.amount === "number",
          },
        });

        return {
          item_id: itemId,
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
