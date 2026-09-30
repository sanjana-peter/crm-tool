import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The OAuth `state` parameter round-trips through the provider, so it must be
 * tamper-proof and say who started the flow — otherwise an attacker could feed
 * us their own authorization `code` and attach *their* account to a victim's
 * organization (login CSRF). Signed with a server-side secret, short-lived.
 */

interface StatePayload {
  orgId: string;
  userId: string;
  /** The flow connects the user's own account rather than an org-wide one. Signed, so it can't be flipped. */
  personal?: boolean;
  nonce: string;
  issuedAt: number;
}

const STATE_TTL_MS = 10 * 60 * 1000;

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function createSignedState(
  secret: string,
  orgId: string,
  userId: string,
  options: { personal?: boolean } = {}
): string {
  const payload: StatePayload = {
    orgId,
    userId,
    ...(options.personal ? { personal: true } : {}),
    nonce: randomBytes(16).toString("base64url"),
    issuedAt: Date.now(),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifySignedState(
  secret: string,
  state: string | null
): { orgId: string; userId: string; personal?: true } | null {
  if (!state) return null;
  const [encoded, signature] = state.split(".");
  if (!encoded || !signature) return null;

  const expected = Buffer.from(sign(encoded, secret));
  const received = Buffer.from(signature);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as StatePayload;
    if (typeof payload.issuedAt !== "number" || Date.now() - payload.issuedAt > STATE_TTL_MS) return null;
    if (typeof payload.orgId !== "string" || typeof payload.userId !== "string") return null;
    return { orgId: payload.orgId, userId: payload.userId, ...(payload.personal === true ? { personal: true as const } : {}) };
  } catch {
    return null;
  }
}
