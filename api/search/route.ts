import axios from "axios";


export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q");

  if (!q) {
    return Response.json({ error: "Missing query" }, { status: 400 });
  }

  const accessToken = getAccessToken()
  try {
    const response = await axios.get(
      `https://api.mercadolibre.com/sites/MLA/search?q=${encodeURIComponent(q)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    return Response.json(response.data.results);
  } catch (error: any) {
    return Response.json(
      { error: error.response?.data || error.message },
      { status: 500 }
    );
  }
}

async function getAccessToken() {
  const tokens = (globalThis as any).meliTokens;

  if (!tokens) {
    throw new Error("No tokens available. Authenticate first.");
  }

  const now = Date.now();

  // Si expiró → refrescar
  if (now >= tokens.expires_at) {
    const response = await axios.post(
      "https://api.mercadolibre.com/oauth/token",
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: process.env.CLIENT_ID!,
        client_secret: process.env.CLIENT_SECRET!,
        refresh_token: tokens.refresh_token,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const refreshed = response.data;

    tokens.access_token = refreshed.access_token;
    tokens.refresh_token = refreshed.refresh_token;
    tokens.expires_at = Date.now() + refreshed.expires_in * 1000;
  }

  return tokens.access_token;
}