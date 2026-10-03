import { createHmac, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as instagramWebhook } from "@/app/api/webhooks/instagram/route";
import { resolveInstagram } from "@/lib/composition/instagram";
import { buildMockInstagramDm } from "@/lib/integrations/instagram/mock-adapter";
import { captureLead } from "@/lib/services/capture";
import {
  getInstagramConversationState,
  listInstagramMessagesForLead,
  sendInstagramText,
  type InstagramRuntime,
} from "@/lib/services/instagram-conversations";
import { SEED_USERS, SYSTEM, admin, countRows, createRivalOrg, manualInput, seedOrgId, sessionFor, userIdOf } from "./support";

const MOCK_SECRET = "dev-mock-webhook-secret";
let orgId: string;
let runtime: InstagramRuntime;
let managerId: string;
let rival: Awaited<ReturnType<typeof createRivalOrg>>;

beforeAll(async () => {
  orgId = await seedOrgId();
  managerId = await userIdOf(SEED_USERS.manager);
  const resolved = await resolveInstagram(admin, orgId);
  if (!resolved) throw new Error("expected demo mode in tests");
  runtime = resolved;
  rival = await createRivalOrg();
});

afterAll(async () => {
  await rival?.cleanup();
});

/** A sender the CRM has never seen. The mock derives the @username from the id. */
const newSender = () => `mock.ig${randomUUID().slice(0, 8)}`;

function dm(senderId: string, options: { mid?: string; text?: string; accountId?: string } = {}) {
  return buildMockInstagramDm({
    accountId: options.accountId ?? `mock:${orgId}`,
    senderId,
    text: options.text ?? "Hi, what are the fees?",
    messageId: options.mid ?? `mock.ig.in.${randomUUID()}`,
  });
}

function envelope(accountId: string, messaging: unknown[]) {
  return JSON.stringify({ object: "instagram", entry: [{ id: accountId, time: Date.now(), messaging }] });
}

function post(body: string, secret = MOCK_SECRET, signed = true) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signed) headers["x-mock-signature"] = `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
  return instagramWebhook(new NextRequest("http://localhost/api/webhooks/instagram", { method: "POST", body, headers }));
}

async function results(response: Response) {
  expect(response.status).toBe(200);
  return ((await response.json()) as { results: Array<{ outcome: string; kind: string }> }).results;
}

async function leadOf(senderId: string, org = orgId) {
  const { data: contact } = await admin
    .from("contacts")
    .select("id, first_name, source, instagram_user_id, instagram_username, phone, email, instagram_consent_status")
    .eq("org_id", org)
    .eq("instagram_user_id", senderId)
    .maybeSingle();
  if (!contact) return null;
  const { data: leads } = await admin.from("leads").select("id, source, assigned_to").eq("contact_id", contact.id);
  return { contact, leads: leads ?? [] };
}

describe("demo mode selection", () => {
  it("uses the mock adapter, flagged as demo, when the org has no Instagram connection", () => {
    expect(runtime.mode).toBe("demo");
    expect(runtime.provider.isMock).toBe(true);
  });
});

describe("a DM from someone new", () => {
  it("creates exactly one contact and lead (source Instagram) and puts the message on it", async () => {
    const sender = newSender();
    const outcomes = await results(await post(dm(sender, { text: "Do you have weekend batches?" })));
    expect(outcomes).toEqual([{ providerMessageId: expect.any(String), kind: "message", outcome: "processed" }]);

    const found = await leadOf(sender);
    expect(found?.contact).toMatchObject({
      first_name: `@${sender.slice("mock.".length)}`,
      instagram_username: sender.slice("mock.".length),
      phone: null,
      email: null,
    });
    expect(found?.leads).toHaveLength(1);
    expect(found?.leads[0].source).toBe("Instagram");

    const leadId = found!.leads[0].id as string;
    const messages = await listInstagramMessagesForLead(admin, leadId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ direction: "inbound", status: "received", body: "Do you have weekend batches?" });

    const { data: activities } = await admin.from("activities").select("activity_type, title, actor_id").eq("lead_id", leadId);
    expect(activities?.map((a) => a.activity_type)).toEqual(expect.arrayContaining(["lead_created", "instagram_received"]));
    expect(activities?.find((a) => a.activity_type === "lead_created")?.title).toMatch(/instagram dm/i);
  });

  it("puts their next DM on the same lead instead of creating another", async () => {
    const sender = newSender();
    await post(dm(sender, { text: "Hello" }));
    await post(dm(sender, { text: "Are you there?" }));

    const found = await leadOf(sender);
    expect(found?.leads).toHaveLength(1);
    expect(await listInstagramMessagesForLead(admin, found!.leads[0].id as string)).toHaveLength(2);
  });

  it("creates one lead when a burst of first DMs arrives as concurrent deliveries", async () => {
    const sender = newSender();
    const bodies = Array.from({ length: 5 }, (_, i) => dm(sender, { text: `message ${i}` }));
    const responses = await Promise.all(bodies.map((body) => post(body)));
    const outcomes = (await Promise.all(responses.map(results))).map((r) => r[0].outcome);
    // A loser may be told to retry ("failed"); none may create a second lead.
    expect(outcomes.every((o) => o === "processed" || o === "failed")).toBe(true);

    const found = await leadOf(sender);
    expect(found?.leads).toHaveLength(1);
    expect(await countRows("contacts", { org_id: orgId, instagram_user_id: sender })).toBe(1);

    // Meta redelivers the ones that failed; every message ends up stored exactly once.
    for (const [i, outcome] of outcomes.entries()) {
      if (outcome === "failed") expect((await results(await post(bodies[i])))[0].outcome).toBe("processed");
    }
    expect(await listInstagramMessagesForLead(admin, found!.leads[0].id as string)).toHaveLength(5);
  });

  it("applies the same delivery only once, however many times it is redelivered", async () => {
    const sender = newSender();
    const body = dm(sender, { mid: `mock.ig.in.${randomUUID()}` });
    expect((await results(await post(body)))[0].outcome).toBe("processed");
    expect((await results(await post(body)))[0].outcome).toBe("duplicate");

    const found = await leadOf(sender);
    expect(found?.leads).toHaveLength(1);
    expect(await listInstagramMessagesForLead(admin, found!.leads[0].id as string)).toHaveLength(1);
  });

  it("labels a photo or story reply instead of storing nothing", async () => {
    const sender = newSender();
    await post(
      envelope(`mock:${orgId}`, [
        { sender: { id: sender }, recipient: { id: `mock:${orgId}` }, timestamp: Date.now(), message: { mid: `m.${randomUUID()}`, attachments: [{ type: "image", payload: { url: "https://cdn.example/x.jpg" } }] } },
      ])
    );
    const found = await leadOf(sender);
    const [message] = await listInstagramMessagesForLead(admin, found!.leads[0].id as string);
    expect(message).toMatchObject({ message_type: "image", body: "[Photo]", attachment_url: "https://cdn.example/x.jpg" });
  });
});

describe("inbound webhook security and tenancy", () => {
  it("rejects a delivery with no signature or a wrong one, storing nothing", async () => {
    const sender = newSender();
    expect((await post(dm(sender), MOCK_SECRET, false)).status).toBe(401);
    expect((await post(dm(sender), "wrong-secret")).status).toBe(401);
    expect(await leadOf(sender)).toBeNull();
  });

  it("ignores an account that isn't connected to any organization", async () => {
    const sender = newSender();
    const outcomes = await results(await post(dm(sender, { accountId: "17841499999999999" })));
    expect(outcomes[0].outcome).toBe("unmatched");
    expect(await leadOf(sender)).toBeNull();
  });

  it("files a DM to the org that owns the account, never another", async () => {
    const sender = newSender();
    await post(dm(sender, { accountId: `mock:${rival.orgId}` }));
    expect(await leadOf(sender, rival.orgId)).not.toBeNull();
    expect(await leadOf(sender, orgId)).toBeNull();
  });

  it("hides another org's Instagram messages from a signed-in user", async () => {
    const sender = newSender();
    await post(dm(sender, { accountId: `mock:${rival.orgId}` }));
    const theirLeadId = (await leadOf(sender, rival.orgId))!.leads[0].id as string;

    const { db } = await sessionFor(SEED_USERS.admin);
    expect(await listInstagramMessagesForLead(db, theirLeadId)).toEqual([]);
    const { data } = await db.from("instagram_messages").select("id").eq("lead_id", theirLeadId);
    expect(data ?? []).toEqual([]);
  });

  it("keeps the token table unreadable to signed-in users", async () => {
    const { db } = await sessionFor(SEED_USERS.admin);
    const { data, error } = await db.from("instagram_tokens").select("*");
    expect(error !== null || (data ?? []).length === 0).toBe(true);
  });
});

describe("replying", () => {
  async function leadFromDm(text = "Hi") {
    const sender = newSender();
    await post(dm(sender, { text }));
    const found = await leadOf(sender);
    return { sender, leadId: found!.leads[0].id as string, contactId: found!.contact.id as string };
  }

  it("sends within the 24-hour window, records it, and marks the lead contacted", async () => {
    const { leadId } = await leadFromDm();
    expect((await getInstagramConversationState(admin, leadId)).windowOpen).toBe(true);

    const result = await sendInstagramText(admin, runtime, { orgId, leadId, body: "Yes — Saturdays at 10.", sentByUserId: managerId });
    expect(result.status).toBe("sent");

    const messages = await listInstagramMessagesForLead(admin, leadId);
    expect(messages[0]).toMatchObject({ direction: "outbound", status: "sent", body: "Yes — Saturdays at 10.", sent_by: managerId, is_echo: false });

    const { data: activities } = await admin.from("activities").select("activity_type, title").eq("lead_id", leadId);
    expect(activities?.find((a) => a.activity_type === "instagram_sent")?.title).toMatch(/demo mode/i);
    const { data: row } = await admin.from("leads").select("first_contacted_at").eq("id", leadId).single();
    expect(row?.first_contacted_at).not.toBeNull();
  });

  it("refuses once the window has closed", async () => {
    const { leadId, contactId } = await leadFromDm();
    await admin
      .from("conversations")
      .update({ last_inbound_at: new Date(Date.now() - 25 * 3_600_000).toISOString() })
      .eq("org_id", orgId)
      .eq("contact_id", contactId)
      .eq("channel", "instagram");
    await expect(sendInstagramText(admin, runtime, { orgId, leadId, body: "Still there?", sentByUserId: managerId })).rejects.toThrow(/24-hour/i);
  });

  it("refuses a lead who never DMed, empty and oversized text, and another org's lead", async () => {
    const manual = await captureLead(admin, SYSTEM(orgId), manualInput());
    if (manual.outcome !== "created") throw new Error("setup failed");
    await expect(sendInstagramText(admin, runtime, { orgId, leadId: manual.leadId, body: "Hi", sentByUserId: managerId })).rejects.toThrow(/hasn't messaged you on instagram/i);

    const { leadId } = await leadFromDm();
    await expect(sendInstagramText(admin, runtime, { orgId, leadId, body: "  ", sentByUserId: managerId })).rejects.toThrow(/write a message/i);
    await expect(sendInstagramText(admin, runtime, { orgId, leadId, body: "x".repeat(1001), sentByUserId: managerId })).rejects.toThrow(/1000/);

    const sender = newSender();
    await post(dm(sender, { accountId: `mock:${rival.orgId}` }));
    const theirs = (await leadOf(sender, rival.orgId))!.leads[0].id as string;
    await expect(sendInstagramText(admin, runtime, { orgId, leadId: theirs, body: "Hi", sentByUserId: managerId })).rejects.toThrow(/lead not found/i);
  });

  it("records a failed send on the timeline without marking the integration failing", async () => {
    const sender = `mock.fail${randomUUID().slice(0, 4)}0000`; // the mock rejects recipients ending 0000
    await post(dm(sender));
    const leadId = (await leadOf(sender))!.leads[0].id as string;
    await admin.from("integration_health").delete().eq("org_id", orgId).eq("provider", "instagram");

    const result = await sendInstagramText(admin, runtime, { orgId, leadId, body: "Hi", sentByUserId: managerId });
    expect(result).toMatchObject({ status: "failed", code: "invalid_recipient" });
    expect((await listInstagramMessagesForLead(admin, leadId))[0]).toMatchObject({ status: "failed", error_code: "invalid_recipient" });

    const { data: activities } = await admin.from("activities").select("activity_type").eq("lead_id", leadId);
    expect(activities?.some((a) => a.activity_type === "instagram_failed")).toBe(true);
    expect(await countRows("integration_health", { org_id: orgId, provider: "instagram" })).toBe(0);
  });

  it("stops replies after the customer sends STOP", async () => {
    const { sender, leadId } = await leadFromDm();
    await post(dm(sender, { text: "STOP" }));
    expect((await getInstagramConversationState(admin, leadId)).consent).toBe("opted_out");
    await expect(sendInstagramText(admin, runtime, { orgId, leadId, body: "Hi", sentByUserId: managerId })).rejects.toThrow(/not to be messaged/i);
  });
});

describe("echoes, unsends and read receipts", () => {
  it("does not duplicate a CRM-sent message when Instagram echoes it back", async () => {
    const sender = newSender();
    await post(dm(sender));
    const leadId = (await leadOf(sender))!.leads[0].id as string;
    const sent = await sendInstagramText(admin, runtime, { orgId, leadId, body: "Hello from the CRM", sentByUserId: managerId });
    if (sent.status !== "sent") throw new Error("setup failed");

    const echo = envelope(`mock:${orgId}`, [
      { sender: { id: `mock:${orgId}` }, recipient: { id: sender }, timestamp: Date.now(), message: { mid: sent.messageId, text: "Hello from the CRM", is_echo: true } },
    ]);
    expect((await results(await post(echo)))[0].outcome).toBe("duplicate");
    expect(await listInstagramMessagesForLead(admin, leadId)).toHaveLength(2);
  });

  it("records a reply typed in the Instagram app itself", async () => {
    const sender = newSender();
    await post(dm(sender));
    const leadId = (await leadOf(sender))!.leads[0].id as string;

    const echo = envelope(`mock:${orgId}`, [
      { sender: { id: `mock:${orgId}` }, recipient: { id: sender }, timestamp: Date.now(), message: { mid: `echo.${randomUUID()}`, text: "Sent from my phone", is_echo: true } },
    ]);
    expect((await results(await post(echo)))[0].outcome).toBe("processed");
    const [latest] = await listInstagramMessagesForLead(admin, leadId);
    expect(latest).toMatchObject({ direction: "outbound", is_echo: true, body: "Sent from my phone", sent_by: null });
  });

  it("removes the text of a message the customer unsent", async () => {
    const sender = newSender();
    const mid = `mock.ig.in.${randomUUID()}`;
    await post(dm(sender, { mid, text: "my address is 12 Hill Road" }));
    const leadId = (await leadOf(sender))!.leads[0].id as string;

    await post(envelope(`mock:${orgId}`, [{ sender: { id: sender }, recipient: { id: `mock:${orgId}` }, timestamp: Date.now(), message: { mid, is_deleted: true } }]));
    const [message] = await listInstagramMessagesForLead(admin, leadId);
    expect(message).toMatchObject({ status: "deleted", body: "[Message unsent]" });
  });

  it("marks the business's earlier messages seen on a read receipt", async () => {
    const sender = newSender();
    await post(dm(sender));
    const leadId = (await leadOf(sender))!.leads[0].id as string;
    const sent = await sendInstagramText(admin, runtime, { orgId, leadId, body: "Here are the details", sentByUserId: managerId });
    if (sent.status !== "sent") throw new Error("setup failed");

    await post(envelope(`mock:${orgId}`, [{ sender: { id: sender }, recipient: { id: `mock:${orgId}` }, timestamp: Date.now() + 1000, read: { mid: sent.messageId } }]));
    const outbound = (await listInstagramMessagesForLead(admin, leadId)).find((m) => m.direction === "outbound");
    expect(outbound).toMatchObject({ status: "read" });
    expect(outbound?.read_at).not.toBeNull();
  });
});
