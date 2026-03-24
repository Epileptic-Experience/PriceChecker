import { NextResponse } from "next/server";

declare global {
  var meliTokens: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  } | undefined;
}

export async function POST(request: Request) {
  const client_id = process.env.NEXT_PUBLIC_CLIENT_ID;
  const client_secret = process.env.CLIENT_SECRET;
  const redirect_uri = process.env.NEXT_PUBLIC_REDIRECT_URI;

  // Obtener el "code" desde el body del request
  const { code, code_verifier } = await request.json();

  if (!code) {
    return Response.json({ error: 'Missing "code" in request body' }, { status: 400 });
  }

  if (!code_verifier) {
    return Response.json(
      { error: 'Missing "code_verifier" in request body' },
      { status: 400 }
    );
  }


  try {
    const response = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client_id!,
        client_secret: client_secret!,
        code: code!,
        code_verifier: code_verifier!,
        redirect_uri: redirect_uri!,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return Response.json({ error: data }, { status: response.status });
    }

    const { access_token, refresh_token, expires_in } = data;

    const myRefreshToken = refresh_token;
    globalThis.meliTokens = {
      access_token,
      refresh_token,
      expires_at: Date.now() + expires_in * 1000,
    };


    console.log("Access Token:", access_token);
    console.log("Refresh Token:", myRefreshToken);

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
