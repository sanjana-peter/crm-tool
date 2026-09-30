import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { META_OAUTH_SCOPES, getOAuthRedirectUri, type MetaConfig } from "./config";

interface StatePayload {
  orgId: string;
  userId: string;
  nonce: string;
  issuedAt: number;
}

const STATE_TTL_MS = 10 * 60 * 1000;

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

/**
 * The `state` parameter round-trips through Facebook, so it is signed with the
 * app secret and carries who started the flow. Without this, an attacker could
 * feed us their own `code` and attach their Meta account to someone's org.
 */
export function createOAuthState(config: MetaConfig, orgId: string, userId: string): string {
  const payload: StatePayload = {
    orgId,
    userId,
    nonce: randomBytes(16).toString("base64url"),
    issuedAt: Date.now(),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, config.appSecret)}`;
}

export function verifyOAuthState(
  config: MetaConfig,
  state: string | null
): { orgId: string; userId: string } | null {
  if (!state) return null;

  const [encoded, signature] = state.split(".");
  if (!encoded || !signature) return null;

  const expected = sign(encoded, config.appSecret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as StatePayload;
  } catch {
    return null;
  }

  if (!payload.orgId || !payload.userId) return null;
  if (Date.now() - payload.issuedAt > STATE_TTL_MS) return null;

  return { orgId: payload.orgId, userId: payload.userId };
}

export function buildAuthorizeUrl(config: MetaConfig, state: string): string {
  const url = new URL(`https://www.facebook.com/${config.graphVersion}/dialog/oauth`);
  url.searchParams.set("client_id", config.appId);
  url.searchParams.set("redirect_uri", getOAuthRedirectUri(config));
  url.searchParams.set("state", state);
  url.searchParams.set("scope", META_OAUTH_SCOPES.join(","));
  url.searchParams.set("response_type", "code");
  // Re-show the permission and Page pickers on every connect; otherwise a
  // Page left unticked the first time stays hidden from /me/accounts.
  url.searchParams.set("auth_type", "rerequest");
  return url.toString();
}
