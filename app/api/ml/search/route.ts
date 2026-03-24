type MeliTokens = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
};

declare global {
  var meliTokens: MeliTokens | undefined;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q");

  if (!q) {
    return Response.json({ error: "Missing query" }, { status: 400 });
  }

  try {
    const accessToken = await getAccessToken();
    const response = await fetch(
      `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(q)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return Response.json({ error: data }, { status: response.status });
    }

    return Response.json(data.results);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}

async function getAccessToken() {
  const tokens = globalThis.meliTokens;

  if (!tokens) {
    throw new Error("No tokens available. Authenticate first.");
  }

  const now = Date.now();

  // Si expiró → refrescar
  if (now >= tokens.expires_at) {
    const response = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: process.env.CLIENT_ID!,
        client_secret: process.env.CLIENT_SECRET!,
        refresh_token: tokens.refresh_token,
      }),
    });

    const refreshed = await response.json();

    if (!response.ok) {
      throw new Error(
        typeof refreshed?.message === "string"
          ? refreshed.message
          : "Failed to refresh MercadoLibre token."
      );
    }

    tokens.access_token = refreshed.access_token;
    tokens.refresh_token = refreshed.refresh_token;
    tokens.expires_at = Date.now() + refreshed.expires_in * 1000;
  }

  return tokens.access_token;
}
