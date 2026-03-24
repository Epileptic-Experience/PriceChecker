import { createClient } from "redis";
import { createMlTraceId, isMlDebugEnvEnabled, logMlStep } from "@/lib/server/ml-debug";

if (typeof window !== "undefined") {
  throw new Error("meli-token-store can only be imported on the server.");
}

export type MeliTokens = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
};

const REDIS_TOKEN_KEY = process.env.MELI_TOKEN_REDIS_KEY ?? "meli:tokens";

type MeliRedisClient = ReturnType<typeof createClient>;

type GlobalWithMeliStore = typeof globalThis & {
  __meliTokenStore?: MeliTokenStore;
  __meliRedisClient?: MeliRedisClient;
  __meliRedisConnectPromise?: Promise<MeliRedisClient>;
};

const globalStore = globalThis as GlobalWithMeliStore;

function isMeliTokens(value: unknown): value is MeliTokens {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const data = value as Record<string, unknown>;

  return (
    typeof data.access_token === "string" &&
    typeof data.refresh_token === "string" &&
    typeof data.expires_at === "number"
  );
}

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

  private async getRedisClient() {
    const redisUrl = process.env.REDIS_URL;

    if (!redisUrl) {
      this.log("redis_missing_url");
      throw new Error("REDIS_URL is not configured.");
    }

    if (globalStore.__meliRedisClient?.isOpen) {
      return globalStore.__meliRedisClient;
    }

    if (globalStore.__meliRedisConnectPromise) {
      return globalStore.__meliRedisConnectPromise;
    }

    const client = createClient({ url: redisUrl });

    client.on("error", (error: unknown) => {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.log("redis_client_error", { message });
    });

    this.log("redis_connect_started");

    globalStore.__meliRedisConnectPromise = client
      .connect()
      .then(() => {
        globalStore.__meliRedisClient = client;
        this.log("redis_connect_success");
        return client;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Unknown error";
        this.log("redis_connect_failed", { message });
        throw error;
      })
      .finally(() => {
        globalStore.__meliRedisConnectPromise = undefined;
      });

    return globalStore.__meliRedisConnectPromise;
  }

  private async loadFromRedis() {
    if (this.tokens) {
      return;
    }

    const client = await this.getRedisClient();
    const raw = await client.get(REDIS_TOKEN_KEY);

    if (!raw) {
      this.log("redis_get_miss", { key: REDIS_TOKEN_KEY });
      return;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;

      if (isMeliTokens(parsed)) {
        this.tokens = parsed;
        this.log("redis_get_hit", {
          key: REDIS_TOKEN_KEY,
          expiresAt: parsed.expires_at,
        });
        return;
      }

      this.log("redis_get_invalid_shape", { key: REDIS_TOKEN_KEY });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.log("redis_get_parse_failed", { key: REDIS_TOKEN_KEY, message });
    }
  }

  private async persistToRedis(tokens?: MeliTokens) {
    const client = await this.getRedisClient();

    if (!tokens) {
      await client.del(REDIS_TOKEN_KEY);
      this.log("redis_del", { key: REDIS_TOKEN_KEY });
      return;
    }

    await client.set(REDIS_TOKEN_KEY, JSON.stringify(tokens));
    this.log("redis_set", {
      key: REDIS_TOKEN_KEY,
      expiresAt: tokens.expires_at,
    });
  }

  async set(tokens: MeliTokens) {
    this.tokens = tokens;
    this.log("set_tokens", { expiresAt: tokens.expires_at, storage: "redis+memory" });
    await this.persistToRedis(tokens);
  }

  async clear() {
    this.tokens = undefined;
    this.log("clear_tokens", { storage: "redis+memory" });
    await this.persistToRedis(undefined);
  }

  hasTokens() {
    return Boolean(this.tokens);
  }

  async getValidAccessToken() {
    await this.loadFromRedis();

    if (!this.tokens) {
      this.log("missing_tokens", { storage: "redis+memory" });
      throw new Error("No tokens available. Authenticate first.");
    }

    if (Date.now() < this.tokens.expires_at) {
      this.log("token_valid", {
        expiresInMs: this.tokens.expires_at - Date.now(),
        storage: "redis+memory",
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

    this.log("refresh_started", { storage: "redis+memory" });

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
      storage: "redis+memory",
    });

    await this.persistToRedis(this.tokens);

    return this.tokens.access_token;
  }
}

export function getMeliTokenStore() {
  globalStore.__meliTokenStore ??= new MeliTokenStore();
  return globalStore.__meliTokenStore;
}
