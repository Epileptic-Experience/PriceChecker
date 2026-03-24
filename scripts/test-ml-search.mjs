const ACCESS_TOKEN =
  process.env.ML_ACCESS_TOKEN ??
  "APP_USR-578684441741656-032413-6f469b0245524c6cef397a050d772d40-471400356";

const query = (process.argv[2] ?? "iphone").trim();

async function main() {
  const url = new URL("https://api.mercadolibre.com/products/search");
  url.searchParams.set("status", "active");
  url.searchParams.set("site_id", "MLA");
  url.searchParams.set("q", query);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
  });

  const data = await response.json();

  console.log(`GET ${url.toString()}`);
  console.log("Status:", response.status);

  if (!response.ok) {
    console.error(JSON.stringify(data, null, 2));
    process.exit(1);
  }

  const results = Array.isArray(data.results) ? data.results : [];

  console.log(`Resultados para "${query}": ${results.length}`);
  console.log(
    JSON.stringify(
      results.slice(0, 5).map((item) => ({
        id: item.id,
        name: item.name,
        domain_id: item.domain_id,
        catalog_product_id: item.catalog_product_id,
        status: item.status,
      })),
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
