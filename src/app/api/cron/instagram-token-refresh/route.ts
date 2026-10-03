import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { instagramGraphClient } from "@/lib/composition/instagram";
import { getRequestId, logger } from "@/lib/observability/logger";
import { refreshDueInstagramTokens } from "@/lib/services/instagram";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; nothing else may trigger this. */
function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const received = Buffer.from(request.headers.get("authorization") ?? "");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/**
 * Daily (vercel.json): extends every Instagram token that's due. Long-lived
 * tokens die after ~60 days unless refreshed, and an org whose DMs went quiet
 * for that long would otherwise find Instagram silently disconnected.
 */
export async function GET(request: NextRequest) {
  if (!authorized(request)) return new Response("Unauthorized", { status: 401 });

  const graph = instagramGraphClient();
  if (!graph) return Response.json({ skipped: "Instagram is not configured" });

  const log = logger.child({ requestId: getRequestId(request.headers), route: "cron/instagram-token-refresh" });
  const counts = await refreshDueInstagramTokens(createAdminClient(), graph);
  log.info("instagram.token_refresh_run", counts);
  return Response.json(counts);
}
