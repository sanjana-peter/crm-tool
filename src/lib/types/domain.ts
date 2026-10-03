// Hand-authored domain types layered on top of the generated database types.
// Keep these aligned with supabase/migrations/0001_init_schema.sql.

export type { OrgRole } from "@/lib/domain/permissions";
import type { OrgRole } from "@/lib/domain/permissions";

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
}

export interface OrgMember {
  id: string;
  org_id: string;
  user_id: string;
  role: OrgRole;
  is_active: boolean;
  profile?: Profile;
}

export interface LeadStatus {
  id: string;
  org_id: string;
  key: string;
  label: string;
  sort_order: number;
  is_won: boolean;
  is_lost: boolean;
  is_default: boolean;
}

export interface Lead {
  id: string;
  org_id: string;
  first_name: string;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  source: string;
  status_id: string;
  assigned_to: string | null;
  created_by: string | null;
  /** Set to 'meta' for leads ingested from Meta Lead Ads; null when created by hand. */
  external_provider: string | null;
  /** The provider's own id for this lead (Meta's `leadgen_id`) — the dedupe key. */
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Which ad produced a lead. One row per lead imported from Meta. */
export interface MetaLeadAttribution {
  lead_id: string;
  org_id: string;
  leadgen_id: string;
  page_id: string | null;
  form_id: string | null;
  form_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  ad_id: string | null;
  ad_name: string | null;
  platform: string | null;
  is_organic: boolean;
  field_data: Array<{ name: string; values: string[] }>;
  meta_created_time: string | null;
  created_at: string;
}

export type MetaWebhookEventStatus =
  | "received"
  | "processed"
  | "duplicate"
  | "ignored"
  | "failed";

export interface MetaWebhookEvent {
  id: string;
  org_id: string | null;
  page_id: string | null;
  form_id: string | null;
  leadgen_id: string | null;
  signature_valid: boolean;
  status: MetaWebhookEventStatus;
  error: string | null;
  lead_id: string | null;
  attempts: number;
  received_at: string;
  processed_at: string | null;
}

export interface LeadWithRelations extends Lead {
  status: LeadStatus;
  assignee: Profile | null;
  next_followup?: Followup | null;
  last_activity?: Activity | null;
}

export interface Note {
  id: string;
  org_id: string;
  lead_id: string;
  author_id: string | null;
  content: string;
  created_at: string;
  updated_at: string;
  author?: Profile | null;
}

export type MeetingStatus = "scheduled" | "completed" | "cancelled" | "no_show";

export interface Meeting {
  id: string;
  org_id: string;
  lead_id: string;
  salesperson_id: string | null;
  scheduled_start: string;
  scheduled_end: string | null;
  /** Who created the calendar event: `manual` (pasted link), `calendly`, `google` or `mock` (demo). */
  provider: string;
  title: string | null;
  external_event_id: string | null;
  external_event_url: string | null;
  /** Set when creating/updating the calendar event failed; the meeting is saved regardless. */
  sync_error: string | null;
  external_booking_url: string | null;
  meeting_url: string | null;
  status: MeetingStatus;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type FollowupStatus = "pending" | "completed" | "cancelled";

export interface Followup {
  id: string;
  org_id: string;
  lead_id: string;
  assigned_to: string | null;
  due_date: string;
  due_time: string | null;
  description: string;
  status: FollowupStatus;
  completed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  lead?: Pick<Lead, "id" | "first_name" | "last_name">;
  assignee?: Profile | null;
}

export const ACTIVITY_TYPES = [
  "lead_created",
  "lead_imported_from_ads",
  "lead_imported_from_file",
  "lead_updated",
  "lead_inquiry_received",
  "call_logged",
  "whatsapp_sent",
  "whatsapp_received",
  "whatsapp_failed",
  "instagram_sent",
  "instagram_received",
  "instagram_failed",
  "lead_assigned",
  "status_changed",
  "note_created",
  "meeting_scheduled",
  "meeting_rescheduled",
  "meeting_completed",
  "meeting_cancelled",
  "followup_created",
  "followup_completed",
  "followup_cancelled",
  "followup_rescheduled",
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export interface Activity {
  id: string;
  org_id: string;
  lead_id: string;
  actor_id: string | null;
  activity_type: ActivityType | string;
  title: string;
  description: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  actor?: Profile | null;
}

export const LEAD_SOURCES = [
  "Facebook Ad",
  "Instagram",
  "Referral",
  "Website",
  "Manual",
  "Other",
] as const;

export type LeadSource = (typeof LEAD_SOURCES)[number];
