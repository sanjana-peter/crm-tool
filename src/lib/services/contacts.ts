import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ContactIdentity } from "@/lib/domain/contact";

const UNIQUE_VIOLATION = "23505";

export interface ContactRow {
  id: string;
  org_id: string;
  first_name: string;
  last_name: string | null;
  phone: string | null;
  phone_normalized: string | null;
  additional_phone: string | null;
  email: string | null;
  email_normalized: string | null;
  instagram_user_id: string | null;
  instagram_username: string | null;
  source: string;
  source_detail: string | null;
  tags: string[];
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewContact {
  firstName: string;
  lastName?: string | null;
  phone?: string | null;
  additionalPhone?: string | null;
  email?: string | null;
  instagramUsername?: string | null;
  source: string;
  sourceDetail?: string | null;
  tags?: string[];
  createdBy: string | null;
}

/**
 * Finds the contact for a phone/email/Instagram id in the caller's org, whoever owns it.
 * Goes through a SECURITY DEFINER function because a salesperson's RLS view
 * hides colleagues' contacts, yet dedupe must still see them — otherwise two
 * reps would race into the unique index instead of joining the same person.
 */
export async function findContactForCapture(
  db: SupabaseClient,
  orgId: string,
  identity: Pick<ContactIdentity, "phoneNormalized" | "emailNormalized" | "instagramUserId">
): Promise<string | null> {
  const { data, error } = await db.rpc("find_contact_for_capture", {
    p_org: orgId,
    p_phone_normalized: identity.phoneNormalized,
    p_email_normalized: identity.emailNormalized,
    p_instagram_user_id: identity.instagramUserId ?? null,
  });
  if (error) throw new Error(`Failed to look up contact: ${error.message}`);
  return (data as string | null) ?? null;
}

/**
 * Inserts a contact. Returns `{ id, created: false }` when a concurrent
 * request created the same person first (the partial unique indexes on
 * normalized phone/email decide who wins), so callers never see a raw
 * unique-violation for something that is really "already exists".
 */
export async function createContact(
  db: SupabaseClient,
  orgId: string,
  input: NewContact,
  identity: ContactIdentity
): Promise<{ id: string; created: boolean }> {
  const { data, error } = await db
    .from("contacts")
    .insert({
      org_id: orgId,
      first_name: input.firstName,
      last_name: input.lastName || null,
      phone: input.phone?.trim() || null,
      phone_normalized: identity.phoneNormalized,
      additional_phone: input.additionalPhone?.trim() || null,
      additional_phone_normalized: identity.additionalPhoneNormalized,
      email: input.email?.trim() || null,
      email_normalized: identity.emailNormalized,
      instagram_user_id: identity.instagramUserId ?? null,
      instagram_username: input.instagramUsername?.trim().replace(/^@/, "") || null,
      source: input.source,
      source_detail: input.sourceDetail ?? null,
      tags: input.tags ?? [],
      created_by: input.createdBy,
    })
    .select("id")
    .single();

  if (!error) return { id: data.id as string, created: true };

  if (error.code === UNIQUE_VIOLATION) {
    const existing = await findContactForCapture(db, orgId, identity);
    if (existing) return { id: existing, created: false };
  }
  throw new Error(`Failed to create contact: ${error.message}`);
}

/**
 * A repeat inquiry may carry a channel the contact didn't have (their email,
 * the second time round). Fill blanks only — never overwrite what a
 * salesperson may have corrected by hand. Best-effort: RLS silently skips
 * contacts the caller can't see.
 */
export async function fillMissingContactFields(
  db: SupabaseClient,
  contactId: string,
  input: Pick<NewContact, "phone" | "email">,
  identity: ContactIdentity
): Promise<void> {
  const { data: contact } = await db
    .from("contacts")
    .select("phone, email")
    .eq("id", contactId)
    .maybeSingle();
  if (!contact) return;

  const patch: Record<string, string | null> = {};
  if (!contact.phone && input.phone?.trim()) {
    patch.phone = input.phone.trim();
    patch.phone_normalized = identity.phoneNormalized;
  }
  if (!contact.email && input.email?.trim()) {
    patch.email = input.email.trim();
    patch.email_normalized = identity.emailNormalized;
  }
  if (Object.keys(patch).length === 0) return;

  // A filled-in key might collide with another contact; that just means the
  // two people are the same and a manager should merge them — not our error.
  await db.from("contacts").update(patch).eq("id", contactId);
}

export async function updateContact(
  db: SupabaseClient,
  contactId: string,
  input: {
    firstName: string;
    lastName?: string | null;
    phone?: string | null;
    additionalPhone?: string | null;
    email?: string | null;
    source?: string;
    tags?: string[];
  },
  identity: ContactIdentity
): Promise<void> {
  const patch: Record<string, unknown> = {
    first_name: input.firstName,
    last_name: input.lastName || null,
    phone: input.phone?.trim() || null,
    phone_normalized: identity.phoneNormalized,
    additional_phone: input.additionalPhone?.trim() || null,
    additional_phone_normalized: identity.additionalPhoneNormalized,
    email: input.email?.trim() || null,
    email_normalized: identity.emailNormalized,
  };
  if (input.source !== undefined) patch.source = input.source;
  if (input.tags !== undefined) patch.tags = input.tags;

  const { error } = await db.from("contacts").update(patch).eq("id", contactId);
  if (error) {
    if (error.code === UNIQUE_VIOLATION) {
      throw new Error("Another contact in this organization already uses that phone number or email.");
    }
    throw new Error(`Failed to update contact: ${error.message}`);
  }
}
