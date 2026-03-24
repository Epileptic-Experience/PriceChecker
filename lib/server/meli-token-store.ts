import { createMlTraceId, isMlDebugEnvEnabled, logMlStep } from "@/lib/server/ml-debug";

if (typeof window !== "undefined") {
  throw new Error("meli-token-store can only be imported on the server.");
}

export type MeliTokens = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
};

class MeliTokenStore {
  private tokens?: MeliTokens;
  private readonly traceId = createMlTraceId("token-store");

  private log(step: string, details?: Record<string, unknown>) {
    logMlStep({
      enabled: isMlDebugEnvEnabled(),
      route: "ml/token-store",
      traceId: this.traceId,
      step,
      details,
    });
  }

  set(tokens: MeliTokens) {
    this.tokens = tokens;
    this.log("set_tokens", { expiresAt: tokens.expires_at, storage: "memory" });
  }

  clear() {
    this.tokens = undefined;
    this.log("clear_tokens", { storage: "memory" });
  }

  hasTokens() {
    return Boolean(this.tokens);
  }

  async getValidAccessToken() {
    if (!this.tokens) {
      this.log("missing_tokens", { storage: "memory" });
      throw new Error("No tokens available. Authenticate first.");
    }

    if (Date.now() < this.tokens.expires_at) {
      this.log("token_valid", {
        expiresInMs: this.tokens.expires_at - Date.now(),
        storage: "memory",
      });
      return this.tokens.access_token;
    }

    const clientId = process.env.CLIENT_ID ?? process.env.NEXT_PUBLIC_CLIENT_ID;
    const clientSecret = process.env.CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      this.log("missing_credentials", {
        hasClientId: Boolean(clientId),
        hasClientSecret: Boolean(clientSecret),
      });
      throw new Error("MercadoLibre credentials are not configured.");
    }

    this.log("refresh_started", { storage: "memory" });

    const response = await fetch("https://api.mercadolibre.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: this.tokens.refresh_token,
      }),
    });

    const refreshed = await response.json();

    if (!response.ok) {
      this.log("refresh_failed", {
        status: response.status,
      });

      throw new Error(
        typeof refreshed?.message === "string"
          ? refreshed.message
          : "Failed to refresh MercadoLibre token."
      );
    }

    this.tokens = {
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token,
      expires_at: Date.now() + refreshed.expires_in * 1000,
    };

    this.log("refresh_success", {
      expiresAt: this.tokens.expires_at,
      storage: "memory",
    });

    return this.tokens.access_token;
  }
}

const globalTokenStore = globalThis as typeof globalThis & {
  __meliTokenStore?: MeliTokenStore;
};

export function getMeliTokenStore() {
  globalTokenStore.__meliTokenStore ??= new MeliTokenStore();
  return globalTokenStore.__meliTokenStore;
}
