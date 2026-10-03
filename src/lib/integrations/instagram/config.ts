import "server-only";
import { readAppUrl, readGraphVersion } from "@/lib/integrations/meta/config";

/**
 * Instagram app credentials (Instagram API with Instagram Login). The
 * Instagram product inside the Meta app has its own app id and secret,
 * distinct from META_APP_ID / META_APP_SECRET. One app serves every org; each
 * org's own access token lives (encrypted) in `instagram_tokens`.
 */
export interface InstagramConfig {
  appId: string;
  appSecret: string;
  /**
   * Meta has signed Instagram webhooks with either the Instagram app secret or
   * the parent Meta app's secret depending on the app's setup, so a delivery
   * is accepted if it verifies against any of these.
   */
  webhookSecrets: string[];
  webhookVerifyToken: string;
  graphVersion: string;
  /** Public origin of this deployment, used to build the OAuth redirect URI. */
  appUrl: string;
}

export const INSTAGRAM_OAUTH_SCOPES = ["instagram_business_basic", "instagram_business_manage_messages"] as const;

/** Webhook fields the connected account is subscribed to. */
export const INSTAGRAM_WEBHOOK_FIELDS = ["messages", "messaging_seen"] as const;

/** Returns null when the Instagram app isn't configured, so the UI can say what's missing. */
export function getInstagramConfig(): InstagramConfig | null {
  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  const webhookVerifyToken = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN || process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!appId || !appSecret || !webhookVerifyToken) return null;

  const metaSecret = process.env.META_APP_SECRET;
  return {
    appId,
    appSecret,
    webhookSecrets: metaSecret && metaSecret !== appSecret ? [appSecret, metaSecret] : [appSecret],
    webhookVerifyToken,
    graphVersion: readGraphVersion(),
    appUrl: readAppUrl(),
  };
}

export function getInstagramOAuthRedirectUri(config: InstagramConfig): string {
  return `${config.appUrl}/api/integrations/instagram/callback`;
}

export function getInstagramWebhookUrl(config: InstagramConfig): string {
  return `${config.appUrl}/api/webhooks/instagram`;
}
