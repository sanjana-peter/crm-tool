import "server-only";
import { createSignedState, verifySignedState } from "@/lib/security/oauth-state";
import { getInstagramOAuthRedirectUri, INSTAGRAM_OAUTH_SCOPES, type InstagramConfig } from "./config";

/** Signed with the Instagram app secret: it says which org and admin started the flow. */
export function createInstagramOAuthState(config: InstagramConfig, orgId: string, userId: string): string {
  return createSignedState(config.appSecret, orgId, userId);
}

export function verifyInstagramOAuthState(config: InstagramConfig, state: string | null) {
  return verifySignedState(config.appSecret, state);
}

/** Instagram Login's consent screen — no Facebook account or Page involved. */
export function buildInstagramAuthorizeUrl(config: InstagramConfig, state: string): string {
  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("redirect_uri", getInstagramOAuthRedirectUri(config));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", INSTAGRAM_OAUTH_SCOPES.join(","));
  url.searchParams.set("state", state);
  // Always show the consent screen, so a scope left unticked can be granted on reconnect.
  url.searchParams.set("force_reauth", "true");
  return url.toString();
}
