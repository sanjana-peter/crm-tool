import type { NextRequest } from "next/server";
import { ZodError } from "zod";
import { getMockWebhookSecret } from "@/lib/integrations/mock/config";
import { MockLeadSource } from "@/lib/integrations/mock/lead-source";
import { getRequestId, logger } from "@/lib/observability/logger";
import { checkRateLimit, clientIp, tooManyRequests } from "@/lib/security/rate-limit";
import { assignmentStrategyFor } from "@/lib/services/assignment";
import { captureLead, inboundToCaptureInput, type CaptureResult } from "@/lib/services/capture";
import { markConnected, markFailing } from "@/lib/services/integration-health";
import { beginReceipt, finishReceipt } from "@/lib/services/webhooks";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Test/demo lead source (no provider credentials needed). Same shape as a real
 * webhook: HMAC-verified over the exact raw body, rate-limited, idempotent
 * (redelivering the same lead id any number of times creates it once), and it
 * flows through the same `captureLead` service as Meta and manual entry.
 * Disabled — 404 — unless mock providers are enabled (docs/DECISIONS D-017).
 */
export async function POST(request: NextRequest) {
  const secret = getMockWebhookSecret();
  if (!secret) return new Response("Not found", { status: 404 });

  const requestId = getRequestId(request.headers);
  const log = logger.child({ requestId, provider: "mock", route: "webhooks/mock-lead" });
  const admin = createAdminClient();

  // Coarse limit first, so anonymous junk can't reach the database at all.
  const ipLimit = await checkRateLimit(admin, { key: `webhook:mock:ip:${clientIp(request.headers)}`, limit: 300, windowSeconds: 60 });
  if (!ipLimit.allowed) return tooManyRequests(ipLimit.retryAfterSeconds);

  // The HMAC is over the exact bytes received: verify before parsing.
  const rawBody = await request.text();
  const source = new MockLeadSource(secret);
  if (!source.verify(rawBody, request.headers)) {
    log.warn("webhook.rejected", { reason: "bad_signature" });
    return new Response("Invalid signature", { status: 401 });
  }

  let orgId: string;
  let events;
  try {
    orgId = source.parseOrgId(rawBody);
    events = source.parse(rawBody);
  } catch (error) {
    log.warn("webhook.rejected", { reason: "malformed", detail: error instanceof ZodError ? error.issues[0]?.message : "invalid JSON" });
    return Response.json({ error: "Malformed payload" }, { status: 400 });
  }

  const orgLimit = await checkRateLimit(admin, { key: `webhook:mock:org:${orgId}`, limit: 600, windowSeconds: 60 });
  if (!orgLimit.allowed) return tooManyRequests(orgLimit.retryAfterSeconds);

  const { data: org } = await admin.from("organizations").select("id").eq("id", orgId).maybeSingle();
  if (!org) {
    log.warn("webhook.ignored", { reason: "unknown_org", orgId });
    return Response.json({ error: "Unknown organization" }, { status: 404 });
  }

  const results: Array<{ externalId: string; outcome: CaptureResult["outcome"] | "failed"; leadId?: string | null }> = [];

  for (const event of events) {
    const receipt = await beginReceipt(admin, {
      provider: source.id,
      eventKey: `${orgId}:${event.externalId}`,
      orgId,
      requestId,
    });

    if (receipt.alreadyHandled) {
      results.push({ externalId: event.externalId, outcome: "duplicate" });
      continue;
    }

    try {
      const lead = await source.resolve(event);
      const outcome = await captureLead(
        admin,
        { orgId, userId: null, role: null },
        inboundToCaptureInput(lead),
        { assignment: await assignmentStrategyFor(admin, orgId) }
      );
      await finishReceipt(admin, receipt.id, { status: outcome.outcome === "duplicate" ? "duplicate" : "processed" });
      results.push({
        externalId: event.externalId,
        outcome: outcome.outcome,
        leadId: "leadId" in outcome ? outcome.leadId : null,
      });
      log.info("webhook.processed", { orgId, externalId: event.externalId, outcome: outcome.outcome });
    } catch (error) {
      await finishReceipt(admin, receipt.id, { status: "failed", error });
      await markFailing(admin, orgId, "mock_lead_source", error);
      log.error("webhook.failed", { orgId, externalId: event.externalId, error });
      results.push({ externalId: event.externalId, outcome: "failed" });
    }
  }

  if (results.some((r) => r.outcome !== "failed")) await markConnected(admin, orgId, "mock_lead_source");

  // 200 even when some leads failed: the failure is recorded on the receipt and
  // a retry of the same delivery will reprocess only those (see beginReceipt).
  return Response.json({ requestId, results });
}
