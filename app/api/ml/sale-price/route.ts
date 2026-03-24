import { getMeliTokenStore } from "@/lib/server/meli-token-store";

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

export async function POST(request: Request) {
  let payload: SalePricePayload;

  try {
    payload = (await request.json()) as SalePricePayload;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const itemIds = normalizeItemIds(payload.item_ids);

  if (itemIds.length === 0) {
    return Response.json(
      { error: 'Missing "item_ids" array in request body' },
      { status: 400 }
    );
  }

  const context =
    readString(payload.context)?.trim() || process.env.ML_SALE_PRICE_CONTEXT || DEFAULT_CONTEXT;

  try {
    const accessToken = await getMeliTokenStore().getValidAccessToken();

    const results = await Promise.all(
      itemIds.map(async (itemId): Promise<SalePriceResult> => {
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
          const errorMessage =
            typeof data?.message === "string" ? data.message : "MercadoLibre request failed.";

          return {
            item_id: itemId,
            amount: null,
            regular_amount: null,
            currency_id: null,
            price_id: null,
            reference_date: null,
            error: errorMessage,
          };
        }

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

    return Response.json({ context, results });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
