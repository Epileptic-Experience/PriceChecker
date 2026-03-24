const query = process.argv[2] ?? "iphone";
const url = `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(query)}`;

async function main() {
  const response = await fetch(url);

  const data = await response.json();

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
        title: item.title,
        price: item.price,
        currency_id: item.currency_id,
        permalink: item.permalink,
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
