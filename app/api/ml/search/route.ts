import { getMeliTokenStore } from "@/lib/server/meli-token-store";

type ProductSearchResult = {
  id: string;
  name: string;
  domain_id?: string;
  catalog_product_id?: string;
  status?: string;
};

type ProductSearchResponse = {
  results?: ProductSearchResult[];
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();

  if (!q) {
    return Response.json({ error: "Missing query" }, { status: 400 });
  }

  try {
    const accessToken = await getMeliTokenStore().getValidAccessToken();
    const url = new URL("https://api.mercadolibre.com/products/search");

    url.searchParams.set("status", "active");
    url.searchParams.set("site_id", "MLA");
    url.searchParams.set("q", q);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const data = (await response.json()) as ProductSearchResponse | { message?: string };

    if (!response.ok) {
      const message =
        "message" in data && typeof data.message === "string"
          ? data.message
          : "MercadoLibre request failed.";
      return Response.json({ error: message }, { status: response.status });
    }

    return Response.json(data.results ?? []);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
