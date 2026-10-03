import type { NextRequest } from "next/server";
import { instagramWebhookProviders } from "@/lib/composition/instagram";
import { getInstagramConfig } from "@/lib/integrations/instagram/config";
import { getRequestId, logger } from "@/lib/observability/logger";
import { checkRateLimit, clientIp, tooManyRequests } from "@/lib/security/rate-limit";
import { handleInstagramEvents } from "@/lib/services/instagram-conversations";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Meta's subscription handshake: echo `hub.challenge` if the verify token matches. */
export async function GET(request: NextRequest) {
  const config = getInstagramConfig();
  if (!config) return new Response("Integration not configured", { status: 503 });

  const params = request.nextUrl.searchParams;
  if (params.get("hub.mode") !== "subscribe" || params.get("hub.verify_token") !== config.webhookVerifyToken) {
    return new Response("Forbidden", { status: 403 });
  }
  return new Response(params.get("hub.challenge") ?? "", { status: 200, headers: { "content-type": "text/plain" } });
}

/**
 * Instagram DMs, echoes, unsends and read receipts. Verified against the
 * exact raw body by whichever provider's signature matches (Meta's, or the
 * mock's in demo mode), rate-limited, then applied idempotently.
 *
 * Processing failures still answer 200: they're recorded on the receipt and
 * healed by Meta's own retry, whereas sustained non-2xx answers would make
 * Meta disable the subscription.
 */
export async function POST(request: NextRequest) {
  const requestId = getRequestId(request.headers);
  const log = logger.child({ requestId, provider: "instagram", route: "webhooks/instagram" });
  const admin = createAdminClient();

  const ipLimit = await checkRateLimit(admin, {
    key: `webhook:instagram:ip:${clientIp(request.headers)}`,
    limit: 600,
    windowSeconds: 60,
  });
  if (!ipLimit.allowed) return tooManyRequests(ipLimit.retryAfterSeconds);

  const providers = instagramWebhookProviders();
  if (providers.length === 0) return new Response("Integration not configured", { status: 503 });

  // The HMAC covers the exact bytes: verify before parsing.
  const rawBody = await request.text();
  const provider = providers.find((p) => p.verifyWebhook(rawBody, request.headers));
  if (!provider) {
    log.warn("webhook.rejected", { reason: "bad_signature" });
    return new Response("Invalid signature", { status: 401 });
  }

  let events;
  try {
    events = provider.parseWebhook(rawBody);
  } catch {
    log.warn("webhook.rejected", { reason: "malformed" });
    return new Response("Malformed payload", { status: 400 });
  }

  const results = await handleInstagramEvents(admin, { provider, events, requestId, log });
  log.info("webhook.processed", { provider: provider.id, events: results.length });
  return Response.json({ requestId, results });
}
