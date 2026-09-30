import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseLeadCsv } from "@/lib/domain/csv-import";
import { UserError } from "@/lib/domain/errors";
import { permissions, type OrgRole } from "@/lib/domain/permissions";
import type { OpportunityPriority } from "@/lib/domain/opportunity";
import { LEAD_SOURCES, type LeadSource } from "@/lib/types/domain";
import { assignmentStrategyFor } from "@/lib/services/assignment";
import { CaptureError, captureLead } from "@/lib/services/capture";
import { markConnected, markFailing } from "@/lib/services/integration-health";
import { recordAudit } from "@/lib/services/audit";

export const FILE_IMPORT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_ROWS = 1000;

export interface FileImportSummary {
  fileName: string;
  totalRows: number;
  created: number;
  merged: number;
  duplicate: number;
  restricted: number;
  failed: number;
  errors: Array<{ rowNumber: number; message: string }>;
}

const PRIORITIES: readonly OpportunityPriority[] = ["low", "medium", "high"];

function resolveSource(raw: string | null): { source: LeadSource; sourceDetail: string | null } {
  if (!raw) return { source: "Other", sourceDetail: "File import" };
  const match = LEAD_SOURCES.find((s) => s.toLowerCase() === raw.toLowerCase());
  return match ? { source: match, sourceDetail: null } : { source: "Other", sourceDetail: raw };
}

function resolvePriority(raw: string | null): OpportunityPriority | undefined {
  return raw && (PRIORITIES as readonly string[]).includes(raw) ? (raw as OpportunityPriority) : undefined;
}

/**
 * Bulk lead capture from an admin-uploaded CSV file — a fourth door onto the
 * same `captureLead` service manual entry, Meta and the mock source use, so
 * an imported row is normalized and deduped identically (DECISIONS D-026).
 *
 * Every row is captured under the uploading admin's own session (RLS-scoped
 * `db`), exactly like manual entry; only the integration-health bookkeeping
 * needs the service-role `admin` client, since that table has no write
 * policy for authenticated roles (0007_v1_domain_model.sql).
 */
export async function importLeadsFromCsv(
  clients: { db: SupabaseClient; admin: SupabaseClient },
  actor: { orgId: string; userId: string; role: OrgRole },
  fileText: string,
  fileName: string
): Promise<FileImportSummary> {
  if (!permissions.canConnectIntegrations(actor.role)) {
    throw new UserError("Only an admin can import leads from a file.");
  }

  const parsed = parseLeadCsv(fileText, { maxRows: MAX_ROWS });
  if (parsed.rows.length === 0 && parsed.errors[0]?.rowNumber === 1) {
    // A structural problem (no header, no name/contact column, empty file) — nothing to import.
    throw new UserError(parsed.errors[0].message);
  }

  const summary: FileImportSummary = {
    fileName,
    totalRows: parsed.rows.length,
    created: 0,
    merged: 0,
    duplicate: 0,
    restricted: 0,
    failed: 0,
    errors: [...parsed.errors],
  };

  // Rows carry no assignee, so under round-robin each new lead takes the next turn.
  const assignment = await assignmentStrategyFor(clients.db, actor.orgId);

  for (const row of parsed.rows) {
    const { source, sourceDetail } = resolveSource(row.source);
    try {
      const result = await captureLead(
        clients.db,
        { orgId: actor.orgId, userId: actor.userId, role: actor.role },
        {
          firstName: row.firstName,
          lastName: row.lastName,
          phone: row.phone,
          email: row.email,
          source,
          sourceDetail: sourceDetail ?? undefined,
          tags: row.tags,
          priority: resolvePriority(row.priority),
          value: row.value,
          // A bad phone shouldn't sink an otherwise-good row of a 500-row import;
          // it's stored as typed and can be fixed on the lead afterwards.
          strictPhone: false,
          timeline: {
            type: "lead_imported_from_file",
            title: "Imported from file",
            description: `${fileName}, row ${row.rowNumber}`,
            metadata: { fileName, rowNumber: row.rowNumber },
          },
        },
        { assignment }
      );
      switch (result.outcome) {
        case "created":
          summary.created++;
          break;
        case "merged":
          summary.merged++;
          break;
        case "duplicate":
          summary.duplicate++;
          break;
        case "existing_restricted":
          summary.restricted++;
          break;
      }
    } catch (error) {
      summary.failed++;
      summary.errors.push({
        rowNumber: row.rowNumber,
        message: error instanceof CaptureError ? error.message : "Could not import this row.",
      });
    }
  }

  if (summary.created + summary.merged + summary.duplicate > 0) {
    await markConnected(clients.admin, actor.orgId, "file_upload");
  } else if (summary.failed > 0) {
    await markFailing(clients.admin, actor.orgId, "file_upload", `${summary.failed} of ${summary.totalRows} rows failed`);
  }

  await recordAudit(clients.db, {
    orgId: actor.orgId,
    actorId: actor.userId,
    action: "leads.imported",
    entityType: "organization",
    entityId: actor.orgId,
    summary: `Imported ${fileName}: ${summary.created} created, ${summary.merged} merged, ${summary.duplicate} duplicate, ${summary.restricted} restricted, ${summary.failed} failed of ${summary.totalRows} rows`,
    metadata: { ...summary },
  });

  return summary;
}
