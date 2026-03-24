import axios from "axios";
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
  const client_secret = process.env.NEXT_PUBLIC_CLIENT_SECRET;
  const redirect_uri = process.env.NEXT_PUBLIC_REDIRECT_URI;

  // Obtener el "code" que viene del redirect de MercadoLibre
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");


  try {
    const response = await axios.post(
      "https://api.mercadolibre.com/oauth/token",
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client_id!,
        client_secret: client_secret!,
        code: code!,
        redirect_uri: redirect_uri!,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const { access_token, refresh_token, expires_in } = response.data;

    const myRefreshToken = refresh_token;
    globalThis.meliTokens = {
      access_token,
      refresh_token,
      expires_at: Date.now() + expires_in * 1000,
    };


    console.log("Access Token:", access_token);
    console.log("Refresh Token:", myRefreshToken);

    return NextResponse.redirect(new URL('/'), 200);
  } catch (error: any) {
    return Response.json(
      { error: error.response?.data || error.message },
      { status: 500 }
    );
  }
}
