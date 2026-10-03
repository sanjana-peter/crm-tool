import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { captureLead } from "@/lib/services/capture";
import { logCall } from "@/lib/services/calls";
import { createFollowup } from "@/lib/services/followups";
import { createNote } from "@/lib/services/notes";
import {
  PASSWORD,
  SEED_USERS,
  SYSTEM,
  admin,
  anonClient,
  createRivalOrg,
  manualInput,
  seedOrgId,
  sessionFor,
  signIn,
  uniquePhone,
} from "./support";

/**
 * Tenant isolation: a user in org A must not be able to read or change org B's
 * data, even knowing its ids and calling the database API directly. These run
 * as real signed-in users, so Row Level Security is the only thing between
 * them and the rows — exactly the "guess the ID / call the API" attack.
 */

const TENANT_TABLES = [
  "leads",
  "contacts",
  "notes",
  "followups",
  "meetings",
  "activities",
  "call_logs",
  "lead_inquiries",
  "whatsapp_messages",
  "instagram_messages",
  "instagram_connections",
  "conversations",
  "meta_lead_attribution",
  "pipelines",
  "lead_statuses",
  "organization_members",
  "audit_events",
  "integration_health",
  "webhook_receipts",
] as const;

let orgA: string;
let rival: Awaited<ReturnType<typeof createRivalOrg>>;
let rivalIds: { leadId: string; contactId: string; stageId: string; pipelineId: string; noteId: string; followupId: string; callId: string };
let jordan: Awaited<ReturnType<typeof sessionFor>>;
let managerA: Awaited<ReturnType<typeof sessionFor>>;
let adminA: Awaited<ReturnType<typeof sessionFor>>;
let rivalAdmin: SupabaseClient;

beforeAll(async () => {
  orgA = await seedOrgId();
  rival = await createRivalOrg();
  jordan = await sessionFor(SEED_USERS.jordan);
  managerA = await sessionFor(SEED_USERS.manager);
  adminA = await sessionFor(SEED_USERS.admin);
  rivalAdmin = await signIn(rival.adminEmail, PASSWORD);

  // Org B gets one of everything, created by its own admin through the real services.
  const rivalSession = await sessionFor(rival.adminEmail);
  const created = await captureLead(rivalSession.db, { orgId: rival.orgId, userId: rival.adminId, role: "admin" }, manualInput({ firstName: "Secret" }));
  if (created.outcome !== "created") throw new Error("rival lead setup failed");

  const note = await createNote(rivalSession.db, rivalSession.session, { lead_id: created.leadId, content: "rival-only note" });
  const followup = await createFollowup(rivalSession.db, rivalSession.session, {
    lead_id: created.leadId,
    due_date: "2030-01-01",
    description: "rival follow-up",
  });
  const call = await logCall(rivalSession.db, rivalSession.session, { lead_id: created.leadId, outcome: "no_answer" });

  const { data: lead } = await admin.from("leads").select("status_id, pipeline_id").eq("id", created.leadId).single();
  rivalIds = {
    leadId: created.leadId,
    contactId: created.contactId,
    stageId: lead!.status_id as string,
    pipelineId: lead!.pipeline_id as string,
    noteId: note.id as string,
    followupId: followup.id as string,
    callId: call.callId,
  };
});

afterAll(async () => {
  await rival?.cleanup();
});

describe("reading another organization's data", () => {
  for (const table of TENANT_TABLES) {
    it(`a salesperson, a manager and an admin from org A see no rows of org B in ${table}`, async () => {
      for (const { db } of [jordan, managerA, adminA]) {
        const { data, error } = await db.from(table).select("*").eq("org_id", rival.orgId);
        expect(error).toBeNull();
        expect(data ?? []).toHaveLength(0);
      }
    });
  }

  it("guessing a row id returns nothing, not an error that confirms it exists", async () => {
    for (const [table, id] of [
      ["leads", rivalIds.leadId],
      ["contacts", rivalIds.contactId],
      ["notes", rivalIds.noteId],
      ["followups", rivalIds.followupId],
      ["call_logs", rivalIds.callId],
      ["lead_statuses", rivalIds.stageId],
      ["pipelines", rivalIds.pipelineId],
    ] as const) {
      const { data, error } = await adminA.db.from(table).select("*").eq("id", id).maybeSingle();
      expect(error, table).toBeNull();
      expect(data, table).toBeNull();
    }
  });

  it("org B's own admin can see their data (the isolation isn't just a broken query)", async () => {
    const { data } = await rivalAdmin.from("leads").select("id").eq("id", rivalIds.leadId);
    expect(data).toHaveLength(1);
  });

  it("org B cannot see org A's data either", async () => {
    const { data: leads } = await rivalAdmin.from("leads").select("id").eq("org_id", orgA);
    expect(leads ?? []).toHaveLength(0);
    const { data: contacts } = await rivalAdmin.from("contacts").select("id").eq("org_id", orgA);
    expect(contacts ?? []).toHaveLength(0);
  });

  it("an unauthenticated client sees nothing", async () => {
    const anon = anonClient();
    for (const table of ["leads", "contacts", "call_logs", "followups", "organization_members"]) {
      const { data } = await anon.from(table).select("*").limit(5);
      expect(data ?? [], table).toHaveLength(0);
    }
  });

  it("cannot look up org B's contacts through the capture helper functions", async () => {
    const lookup = await adminA.db.rpc("find_contact_for_capture", {
      p_org: rival.orgId,
      p_phone_normalized: "+919999999999",
      p_email_normalized: null,
    });
    expect(lookup.error?.code).toBe("42501");

    const open = await adminA.db.rpc("find_open_opportunity_for_capture", { p_org: rival.orgId, p_contact: rivalIds.contactId });
    expect(open.error?.code).toBe("42501");
  });

  it("does not leak org B's contact through capture even for the same phone number", async () => {
    const { data: theirs } = await admin.from("contacts").select("phone_normalized").eq("id", rivalIds.contactId).single();
    const result = await captureLead(
      adminA.db,
      { orgId: orgA, userId: adminA.session.user.id, role: "admin" },
      manualInput({ phone: theirs!.phone_normalized as string })
    );
    expect(result.outcome).toBe("created"); // a brand-new contact in *our* org
    if (result.outcome === "created") expect(result.contactId).not.toBe(rivalIds.contactId);
  });
});

describe("changing another organization's data", () => {
  it("updates and deletes of org B rows affect nothing", async () => {
    const updated = await adminA.db.from("leads").update({ priority: "high" }).eq("id", rivalIds.leadId).select();
    expect(updated.data ?? []).toHaveLength(0);
    const deleted = await adminA.db.from("leads").delete().eq("id", rivalIds.leadId).select();
    expect(deleted.data ?? []).toHaveLength(0);
    const contact = await adminA.db.from("contacts").update({ first_name: "Hacked" }).eq("id", rivalIds.contactId).select();
    expect(contact.data ?? []).toHaveLength(0);

    const { data: lead } = await admin.from("leads").select("priority, first_name").eq("id", rivalIds.leadId).single();
    expect(lead).toMatchObject({ priority: "medium", first_name: "Secret" });
  });

  it("cannot insert a row claiming to belong to org B", async () => {
    const attempts = await Promise.all([
      adminA.db.from("notes").insert({ org_id: rival.orgId, lead_id: rivalIds.leadId, author_id: adminA.session.user.id, content: "planted" }),
      adminA.db.from("call_logs").insert({
        org_id: rival.orgId,
        lead_id: rivalIds.leadId,
        contact_id: rivalIds.contactId,
        caller_id: adminA.session.user.id,
        outcome: "no_answer",
      }),
      adminA.db.from("contacts").insert({ org_id: rival.orgId, first_name: "Planted", phone: uniquePhone() }),
      adminA.db.from("audit_events").insert({
        org_id: rival.orgId,
        actor_id: adminA.session.user.id,
        action: "x",
        entity_type: "x",
        summary: "forged",
      }),
    ]);
    for (const attempt of attempts) expect(attempt.error).not.toBeNull();
  });

  it("cannot attach a note to org B's lead while claiming org A", async () => {
    const attempt = await adminA.db
      .from("notes")
      .insert({ org_id: orgA, lead_id: rivalIds.leadId, author_id: adminA.session.user.id, content: "planted" });
    expect(attempt.error).not.toBeNull();
  });

  it("the database refuses a cross-tenant reference even from the service role", async () => {
    const stage = await admin
      .from("leads")
      .insert({ org_id: orgA, contact_id: rivalIds.contactId, pipeline_id: rivalIds.pipelineId, status_id: rivalIds.stageId, source: "Manual" })
      .select();
    expect(stage.error?.code).toBe("23503");

    // A real org-A lead, then point it at org B's stage / contact / assignee.
    const mine = await captureLead(admin, SYSTEM(orgA), manualInput());
    if (mine.outcome !== "created") throw new Error("setup failed");

    const badStage = await admin.from("leads").update({ status_id: rivalIds.stageId }).eq("id", mine.leadId);
    expect(badStage.error?.code).toBe("23503");

    const badContact = await admin.from("leads").update({ contact_id: rivalIds.contactId }).eq("id", mine.leadId);
    expect(badContact.error?.code).toBe("23503");

    const badAssignee = await admin.from("leads").update({ assigned_to: rival.adminId }).eq("id", mine.leadId);
    expect(badAssignee.error?.code).toBe("23503");

    const badFollowup = await admin.from("followups").insert({
      org_id: orgA,
      lead_id: rivalIds.leadId,
      due_date: "2030-01-01",
      description: "cross-tenant",
    });
    expect(badFollowup.error?.code).toBe("23503");
  });
});

describe("secrets and system tables", () => {
  it("integration token tables are unreadable to every client role", async () => {
    for (const table of ["meta_user_tokens", "meta_page_tokens", "whatsapp_user_tokens", "instagram_tokens", "rate_limits"]) {
      for (const db of [adminA.db, jordan.db, anonClient()]) {
        const { data } = await db.from(table).select("*").limit(1);
        expect(data ?? [], table).toHaveLength(0);
      }
    }
  });

  it("the rate limiter and system RPCs are not callable by a signed-in user", async () => {
    const hit = await adminA.db.rpc("rate_limit_hit", { p_key: "test", p_limit: 1, p_window_seconds: 60 });
    expect(hit.error).not.toBeNull();
  });

  it("the audit trail is append-only for users", async () => {
    const written = await adminA.db
      .from("audit_events")
      .insert({ org_id: orgA, actor_id: adminA.session.user.id, action: "test.append", entity_type: "test", summary: "append-only check" })
      .select("id")
      .single();
    expect(written.error).toBeNull();

    const edit = await adminA.db.from("audit_events").update({ summary: "tampered" }).eq("id", written.data!.id);
    expect(edit.error).not.toBeNull();
    const removal = await adminA.db.from("audit_events").delete().eq("id", written.data!.id);
    expect(removal.error).not.toBeNull();
  });

  it("a salesperson cannot read the org's audit log", async () => {
    const { data } = await jordan.db.from("audit_events").select("id").eq("org_id", orgA);
    expect(data ?? []).toHaveLength(0);
  });
});
