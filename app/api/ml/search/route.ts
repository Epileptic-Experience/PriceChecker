import { getMeliTokenStore } from "@/lib/server/meli-token-store";

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

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();

  if (!q) {
    return Response.json({ error: "Missing query" }, { status: 400 });
  }

  try {
    const accessToken = await getMeliTokenStore().getValidAccessToken();

    const url = new URL("https://api.mercadolibre.com/sites/MLA/search");
    url.searchParams.set("q", q);
    url.searchParams.set("status", "active");
    url.searchParams.set("limit", "20");

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const data = (await response.json().catch(() => null)) as SiteSearchResponse | null;

    if (!response.ok) {
      return Response.json(
        { error: readMeliError(data, response.status) },
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

    return Response.json(results);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
