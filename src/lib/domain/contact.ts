import type { CountryCode } from "libphonenumber-js/min";
import { normalizePhone } from "./phone";

// Deliberately permissive: this decides "does this look like an email worth
// deduping on", not deliverability. Real validation is the mail server's job.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: string | null | undefined): string | null {
  const text = raw?.trim().toLowerCase();
  if (!text || !EMAIL_PATTERN.test(text)) return null;
  return text;
}

export interface ContactIdentityInput {
  phone?: string | null;
  additionalPhone?: string | null;
  email?: string | null;
  /** Instagram-scoped id of someone who DMed the org's account. Already canonical. */
  instagramUserId?: string | null;
}

export interface ContactIdentity {
  phoneNormalized: string | null;
  additionalPhoneNormalized: string | null;
  emailNormalized: string | null;
  /** Present only when the contact came from (or was matched by) Instagram. */
  instagramUserId?: string | null;
}

/**
 * The dedupe keys for a contact. Two contacts in the same org with the same
 * `phoneNormalized`, `emailNormalized` or `instagramUserId` are the same person — the database
 * backs this with partial unique indexes so a race can't create a duplicate.
 */
export function contactIdentity(
  input: ContactIdentityInput,
  defaultCountry?: CountryCode
): ContactIdentity {
  return {
    phoneNormalized: normalizePhone(input.phone, defaultCountry),
    additionalPhoneNormalized: normalizePhone(input.additionalPhone, defaultCountry),
    emailNormalized: normalizeEmail(input.email),
    ...(input.instagramUserId?.trim() ? { instagramUserId: input.instagramUserId.trim() } : {}),
  };
}

/** A contact can't be reached, or deduped, without at least one of these. */
export function hasContactChannel(identity: ContactIdentity): boolean {
  return Boolean(identity.phoneNormalized || identity.emailNormalized || identity.instagramUserId);
}

export function displayName(contact: { firstName: string; lastName?: string | null }): string {
  return [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim();
}
