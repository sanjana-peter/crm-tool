import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger, redact } from "@/lib/observability/logger";

export type IntegrationProvider = "meta" | "whatsapp" | "instagram" | "google_calendar" | "mock_lead_source" | "file_upload";
export type IntegrationStatus = "connected" | "failing" | "disconnected";

export interface IntegrationHealthRow {
  org_id: string;
  provider: IntegrationProvider | string;
  status: IntegrationStatus;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  updated_at: string;
}

const MAX_ERROR_LENGTH = 500;

/** A short, secret-free description of a failure, safe to show to an admin. */
function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const scrubbed = String(redact(raw));
  return scrubbed.length > MAX_ERROR_LENGTH ? scrubbed.slice(0, MAX_ERROR_LENGTH) : scrubbed;
}

async function upsert(admin: SupabaseClient, orgId: string, provider: string, patch: Record<string, unknown>) {
  const { error } = await admin
    .from("integration_health")
    .upsert({ org_id: orgId, provider, updated_at: new Date().toISOString(), ...patch }, { onConflict: "org_id,provider" });
  // Health bookkeeping must never fail the operation it describes.
  if (error) logger.error("integration_health.write_failed", { orgId, provider, error: error.message });
}

/** A real interaction with the provider worked (connect, send, webhook processed). */
export async function markConnected(admin: SupabaseClient, orgId: string, provider: IntegrationProvider) {
  await upsert(admin, orgId, provider, {
    status: "connected",
    last_success_at: new Date().toISOString(),
    last_error: null,
    last_error_at: null,
  });
}

/** A provider interaction failed: the connection exists but isn't working. */
export async function markFailing(admin: SupabaseClient, orgId: string, provider: IntegrationProvider, error: unknown) {
  await upsert(admin, orgId, provider, {
    status: "failing",
    last_error: safeMessage(error),
    last_error_at: new Date().toISOString(),
  });
}

export async function markDisconnected(admin: SupabaseClient, orgId: string, provider: IntegrationProvider) {
  await upsert(admin, orgId, provider, { status: "disconnected", last_error: null, last_error_at: null });
}

export async function listIntegrationHealth(db: SupabaseClient, orgId: string): Promise<IntegrationHealthRow[]> {
  const { data, error } = await db.from("integration_health").select("*").eq("org_id", orgId);
  if (error) throw new Error(`Failed to load integration health: ${error.message}`);
  return (data ?? []) as IntegrationHealthRow[];
}
