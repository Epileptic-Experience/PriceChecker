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

  set(tokens: MeliTokens) {
    this.tokens = tokens;
  }

  clear() {
    this.tokens = undefined;
  }

  hasTokens() {
    return Boolean(this.tokens);
  }

  async getValidAccessToken() {
    if (!this.tokens) {
      throw new Error("No tokens available. Authenticate first.");
    }

    if (Date.now() < this.tokens.expires_at) {
      return this.tokens.access_token;
    }

    const clientId = process.env.CLIENT_ID ?? process.env.NEXT_PUBLIC_CLIENT_ID;
    const clientSecret = process.env.CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error("MercadoLibre credentials are not configured.");
    }

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

    return this.tokens.access_token;
  }
}

let tokenStore: MeliTokenStore | undefined;

export function getMeliTokenStore() {
  tokenStore ??= new MeliTokenStore();
  return tokenStore;
}
