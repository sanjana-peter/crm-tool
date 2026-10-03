import "server-only";
import { MetaApiError } from "@/lib/integrations/meta/client";
import type { InstagramAccountApi } from "@/lib/ports/instagram";
import type { InstagramConfig } from "./config";

export { MetaApiError as InstagramApiError };

interface ErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number } | string;
  error_message?: string;
  error_type?: string;
  code?: number;
}

export interface InstagramTokenResponse {
  access_token: string;
  token_type?: string;
  /** Seconds. Long-lived tokens last about 60 days. */
  expires_in?: number;
}

export interface InstagramShortLivedToken {
  access_token: string;
  user_id: string;
  permissions: string[];
}

export interface InstagramAccount {
  /** The professional account id — what webhooks call `entry[].id`. */
  user_id: string;
  /** The app-scoped id for this login. */
  id: string;
  username: string;
  name?: string;
  profile_picture_url?: string;
}

export interface InstagramSendResponse {
  recipient_id?: string;
  message_id?: string;
}

/**
 * Thin typed wrapper over the Instagram API with Instagram Login
 * (`graph.instagram.com`) and its OAuth endpoints (`api.instagram.com`).
 * Errors become `MetaApiError` so callers classify them the same way as every
 * other Meta integration. Next's fetch cache is bypassed: nothing here may be
 * served stale.
 */
export class InstagramGraphClient implements InstagramAccountApi {
  constructor(private readonly config: InstagramConfig) {}

  private get baseUrl() {
    return `https://graph.instagram.com/${this.config.graphVersion}`;
  }

  private async send<T>(url: URL, init?: RequestInit): Promise<T> {
    const response = await fetch(url, { ...init, cache: "no-store" });
    const body = (await response.json().catch(() => ({}))) as T & ErrorBody;

    const error = body.error;
    if (!response.ok || error) {
      const message =
        (typeof error === "object" ? error.message : error) ??
        body.error_message ??
        `Instagram API request failed with status ${response.status}`;
      const code = typeof error === "object" ? error.code : body.code;
      const subcode = typeof error === "object" ? error.error_subcode : undefined;
      throw new MetaApiError(message, response.status, code, subcode);
    }
    return body as T;
  }

  private async request<T>(
    path: string,
    accessToken: string,
    params: Record<string, string> = {},
    init?: RequestInit
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\//, "")}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set("access_token", accessToken);
    return this.send<T>(url, init);
  }

  // -------------------------------------------------------------------------
  // OAuth
  // -------------------------------------------------------------------------

  /** Swaps the authorization code for a short-lived (1 hour) token. */
  async exchangeCodeForToken(code: string, redirectUri: string): Promise<InstagramShortLivedToken> {
    const form = new URLSearchParams({
      client_id: this.config.appId,
      client_secret: this.config.appSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    });
    const body = await this.send<InstagramShortLivedToken | { data: InstagramShortLivedToken[] }>(
      new URL("https://api.instagram.com/oauth/access_token"),
      { method: "POST", body: form, headers: { "content-type": "application/x-www-form-urlencoded" } }
    );
    // Documented as a flat object; some API versions wrap it in `data`.
    const token = "data" in body ? body.data[0] : body;
    if (!token?.access_token) throw new MetaApiError("Instagram returned no access token.", 502);
    return { ...token, user_id: String(token.user_id) };
  }

  /** Short-lived → long-lived (about 60 days). */
  async exchangeForLongLivedToken(shortLivedToken: string): Promise<InstagramTokenResponse> {
    const url = new URL("https://graph.instagram.com/access_token");
    url.searchParams.set("grant_type", "ig_exchange_token");
    url.searchParams.set("client_secret", this.config.appSecret);
    url.searchParams.set("access_token", shortLivedToken);
    return this.send<InstagramTokenResponse>(url);
  }

  /** Extends a long-lived token by another ~60 days. Only accepted once the token is at least 24 hours old. */
  async refreshLongLivedToken(longLivedToken: string): Promise<InstagramTokenResponse> {
    const url = new URL("https://graph.instagram.com/refresh_access_token");
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", longLivedToken);
    return this.send<InstagramTokenResponse>(url);
  }

  // -------------------------------------------------------------------------
  // Account
  // -------------------------------------------------------------------------

  async getAccount(accessToken: string): Promise<InstagramAccount> {
    const account = await this.request<InstagramAccount>("me", accessToken, {
      fields: "user_id,username,name,profile_picture_url",
    });
    return { ...account, user_id: String(account.user_id), id: String(account.id) };
  }

  /** Subscribes this app to the account's DM webhooks. Replaces the field list. */
  async subscribeWebhooks(accessToken: string, fields: readonly string[]): Promise<void> {
    await this.request("me/subscribed_apps", accessToken, { subscribed_fields: fields.join(",") }, { method: "POST" });
  }

  async unsubscribeWebhooks(accessToken: string): Promise<void> {
    await this.request("me/subscribed_apps", accessToken, {}, { method: "DELETE" });
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  /** Name and @username of someone who messaged the account. */
  async getUserProfile(userId: string, accessToken: string): Promise<{ name?: string; username?: string }> {
    return this.request<{ name?: string; username?: string }>(userId, accessToken, { fields: "name,username" });
  }

  async sendTextMessage(accountId: string, accessToken: string, payload: { recipientId: string; body: string }) {
    return this.request<InstagramSendResponse>(
      `${accountId}/messages`,
      accessToken,
      {},
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipient: { id: payload.recipientId }, message: { text: payload.body } }),
      }
    );
  }
}
