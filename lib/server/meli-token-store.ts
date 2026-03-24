import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createMlTraceId, isMlDebugEnvEnabled, logMlStep } from "@/lib/server/ml-debug";

if (typeof window !== "undefined") {
  throw new Error("meli-token-store can only be imported on the server.");
}

export type MeliTokens = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
};

const TOKEN_STORE_PATH = process.env.MELI_TOKEN_STORE_PATH
  ? resolve(process.env.MELI_TOKEN_STORE_PATH)
  : resolve(process.cwd(), ".data", "meli-tokens.json");

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

  private loadFromDisk() {
    if (this.tokens) {
      return;
    }

    if (!existsSync(TOKEN_STORE_PATH)) {
      this.log("load_skipped", { reason: "file_not_found", path: TOKEN_STORE_PATH });
      return;
    }

    try {
      const raw = readFileSync(TOKEN_STORE_PATH, "utf8");
      const parsed = JSON.parse(raw) as unknown;

      if (isMeliTokens(parsed)) {
        this.tokens = parsed;
        this.log("load_success", {
          expiresAt: this.tokens.expires_at,
        });
        return;
      }

      this.log("load_invalid_shape");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.log("load_failed", { message });
    }
  }

  private persistToDisk(tokens?: MeliTokens) {
    try {
      if (!tokens) {
        if (existsSync(TOKEN_STORE_PATH)) {
          unlinkSync(TOKEN_STORE_PATH);
          this.log("persist_cleared", { path: TOKEN_STORE_PATH });
        }
        return;
      }

      mkdirSync(dirname(TOKEN_STORE_PATH), { recursive: true });
      writeFileSync(TOKEN_STORE_PATH, JSON.stringify(tokens), {
        encoding: "utf8",
        mode: 0o600,
      });

      this.log("persist_success", {
        expiresAt: tokens.expires_at,
        path: TOKEN_STORE_PATH,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.log("persist_failed", { message, path: TOKEN_STORE_PATH });
    }
  }

  set(tokens: MeliTokens) {
    this.tokens = tokens;
    this.log("set_tokens", { expiresAt: tokens.expires_at });
    this.persistToDisk(tokens);
  }

  clear() {
    this.tokens = undefined;
    this.log("clear_tokens");
    this.persistToDisk(undefined);
  }

  hasTokens() {
    this.loadFromDisk();
    return Boolean(this.tokens);
  }

  async getValidAccessToken() {
    this.loadFromDisk();

    if (!this.tokens) {
      this.log("missing_tokens");
      throw new Error("No tokens available. Authenticate first.");
    }

    if (Date.now() < this.tokens.expires_at) {
      this.log("token_valid", {
        expiresInMs: this.tokens.expires_at - Date.now(),
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

    this.log("refresh_started");

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
    });

    this.persistToDisk(this.tokens);

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
