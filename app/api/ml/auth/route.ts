import { NextResponse } from "next/server";
import { getMeliTokenStore } from "@/lib/server/meli-token-store";
import { createMlTraceId, isMlDebugEnabled, logMlStep } from "@/lib/server/ml-debug";

type AuthBody = {
  code?: string;
  code_verifier?: string;
};

export async function POST(request: Request) {
  const debugEnabled = isMlDebugEnabled(request);
  const traceId = createMlTraceId("auth");
  const startedAt = Date.now();

  logMlStep({
    enabled: debugEnabled,
    route: "ml/auth",
    traceId,
    step: "request_started",
  });

  const tokenStore = getMeliTokenStore();
  const clientId = process.env.NEXT_PUBLIC_CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;
  const redirectUri = process.env.NEXT_PUBLIC_REDIRECT_URI;

  let body: AuthBody;

  try {
    body = (await request.json()) as AuthBody;
  } catch {
    logMlStep({
      enabled: debugEnabled,
      route: "ml/auth",
      traceId,
      step: "invalid_json",
    });
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  const codeVerifier = typeof body.code_verifier === "string" ? body.code_verifier.trim() : "";

  if (!code) {
    logMlStep({
      enabled: debugEnabled,
      route: "ml/auth",
      traceId,
      step: "validation_failed",
      details: { reason: "missing_code" },
    });
    return Response.json({ error: 'Missing "code" in request body' }, { status: 400 });
  }

  if (!codeVerifier) {
    logMlStep({
      enabled: debugEnabled,
      route: "ml/auth",
      traceId,
      step: "validation_failed",
      details: { reason: "missing_code_verifier" },
    });
    return Response.json(
      { error: 'Missing "code_verifier" in request body' },
      { status: 400 }
    );
  }

  if (!clientId || !clientSecret || !redirectUri) {
    logMlStep({
      enabled: debugEnabled,
      route: "ml/auth",
      traceId,
      step: "missing_credentials",
      details: {
        hasClientId: Boolean(clientId),
        hasClientSecret: Boolean(clientSecret),
        hasRedirectUri: Boolean(redirectUri),
      },
    });
    return Response.json(
      { error: "MercadoLibre credentials are not configured." },
      { status: 500 }
    );
  }

  try {
    logMlStep({
      enabled: debugEnabled,
      route: "ml/auth",
      traceId,
      step: "oauth_exchange_started",
    });

    const response = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      }),
    });

    const data = await response.json().catch(() => null);

    logMlStep({
      enabled: debugEnabled,
      route: "ml/auth",
      traceId,
      step: "oauth_exchange_finished",
      details: {
        status: response.status,
        ok: response.ok,
      },
    });

    if (!response.ok) {
      return Response.json({ error: data }, { status: response.status });
    }

    const accessToken = typeof data?.access_token === "string" ? data.access_token : null;
    const refreshToken = typeof data?.refresh_token === "string" ? data.refresh_token : null;
    const expiresIn = typeof data?.expires_in === "number" ? data.expires_in : null;

    if (!accessToken || !refreshToken || !expiresIn) {
      logMlStep({
        enabled: debugEnabled,
        route: "ml/auth",
        traceId,
        step: "invalid_oauth_payload",
      });
      return Response.json(
        { error: "OAuth response did not include required token fields." },
        { status: 502 }
      );
    }

    tokenStore.set({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: Date.now() + expiresIn * 1000,
    });

    logMlStep({
      enabled: debugEnabled,
      route: "ml/auth",
      traceId,
      step: "tokens_saved",
      details: {
        expiresIn,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";

    logMlStep({
      enabled: debugEnabled,
      route: "ml/auth",
      traceId,
      step: "request_failed",
      details: {
        message,
      },
    });

    return Response.json({ error: message }, { status: 500 });
  } finally {
    logMlStep({
      enabled: debugEnabled,
      route: "ml/auth",
      traceId,
      step: "request_finished",
      details: {
        durationMs: Date.now() - startedAt,
      },
    });
  }
}
