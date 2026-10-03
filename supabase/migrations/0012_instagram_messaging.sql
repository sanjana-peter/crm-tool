-- Instagram Direct Messages (DECISIONS D-030).
--
-- Each organization connects its own Instagram professional account through
-- Instagram Login (no Facebook Page needed). DMs to that account arrive on
-- `/api/webhooks/instagram`; a sender the CRM has never seen becomes a new
-- contact + lead (source "Instagram"), and salespeople reply from the lead.
--
-- An Instagram sender has no phone number or email — only an Instagram-scoped
-- id (IGSID) — so that id becomes a third contact identity next to the
-- normalized phone and email, with the same database-enforced uniqueness.

-- ============================================================================
-- instagram_connections (one Instagram account per org)
-- ============================================================================
create table instagram_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references organizations (id) on delete cascade,
  -- The professional account id. Webhooks name only this (`entry[].id`), so it
  -- is globally unique: one Instagram account cannot feed two orgs.
  ig_user_id text not null unique,
  username text not null,
  name text,
  profile_picture_url text,
  scopes text[] not null default '{}',
  token_expires_at timestamptz,
  token_refreshed_at timestamptz,
  webhook_subscribed boolean not null default false,
  connected_by uuid references profiles (id) on delete set null,
  connected_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_instagram_connections_updated_at before update on instagram_connections
  for each row execute function set_updated_at();

-- ============================================================================
-- instagram_tokens (SECRET — service role only; AES-GCM encrypted, D-009)
-- ============================================================================
create table instagram_tokens (
  org_id uuid primary key references organizations (id) on delete cascade,
  access_token text not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- contacts: Instagram identity + consent
-- ============================================================================
alter table contacts
  add column instagram_user_id text,
  add column instagram_username text,
  add column instagram_consent_status text not null default 'unknown'
    check (instagram_consent_status in ('unknown', 'opted_in', 'opted_out')),
  add column instagram_consent_at timestamptz;

create unique index idx_contacts_org_instagram on contacts (org_id, instagram_user_id)
  where instagram_user_id is not null;

-- A contact must still be reachable somehow; an Instagram id now counts.
alter table contacts drop constraint contacts_channel_required;
alter table contacts add constraint contacts_channel_required
  check (phone is not null or email is not null or instagram_user_id is not null);

-- leads.phone/email are a display copy of the contact (leads_apply_contact),
-- so the contact's constraint above is the real rule.
alter table leads drop constraint leads_contact_required;

-- The capture lookup learns the third identity. Replaced (not overloaded) so a
-- three-argument call can't be ambiguous.
drop function find_contact_for_capture(uuid, text, text);

create function find_contact_for_capture(
  p_org uuid,
  p_phone_normalized text,
  p_email_normalized text,
  p_instagram_user_id text default null
)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is not null and p_org is distinct from current_org_id() then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;

  if p_phone_normalized is not null then
    select id into v_id from contacts where org_id = p_org and phone_normalized = p_phone_normalized;
    if v_id is not null then return v_id; end if;
  end if;
  if p_email_normalized is not null then
    select id into v_id from contacts where org_id = p_org and email_normalized = p_email_normalized;
    if v_id is not null then return v_id; end if;
  end if;
  if p_instagram_user_id is not null then
    select id into v_id from contacts where org_id = p_org and instagram_user_id = p_instagram_user_id;
  end if;
  return v_id;
end;
$$;

revoke all on function find_contact_for_capture(uuid, text, text, text) from public, anon;
grant execute on function find_contact_for_capture(uuid, text, text, text) to authenticated, service_role;

-- ============================================================================
-- conversations: a second channel
-- ============================================================================
alter table conversations drop constraint conversations_channel_check;
alter table conversations add constraint conversations_channel_check
  check (channel in ('whatsapp', 'instagram'));

-- ============================================================================
-- instagram_messages
-- Separate from whatsapp_messages, whose columns (templates, phone numbers)
-- don't apply here; both hang off `conversations`.
-- ============================================================================
create table instagram_messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  conversation_id uuid not null,
  lead_id uuid not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  message_type text not null default 'text'
    check (message_type in ('text', 'image', 'video', 'audio', 'file', 'story_reply', 'story_mention', 'share', 'unsupported')),
  body text not null,
  -- Instagram's CDN links expire; kept for a short-lived preview only.
  attachment_url text,
  provider_message_id text,
  status text not null check (status in ('sent', 'read', 'failed', 'received', 'deleted')),
  -- Sent from the Instagram app itself rather than from the CRM.
  is_echo boolean not null default false,
  error text check (error is null or length(error) <= 500),
  error_code text,
  sent_by uuid references profiles (id) on delete set null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (org_id, conversation_id) references conversations (org_id, id) on delete cascade,
  foreign key (org_id, lead_id) references leads (org_id, id) on delete cascade
);

-- The provider's message id is the idempotency key for webhook redeliveries,
-- and how the echo of a CRM-sent message finds the row it already has.
create unique index idx_instagram_messages_provider_id
  on instagram_messages (org_id, provider_message_id)
  where provider_message_id is not null;

create index idx_instagram_messages_conversation
  on instagram_messages (conversation_id, created_at desc);

-- ============================================================================
-- Row Level Security
-- ============================================================================
alter table instagram_connections enable row level security;
alter table instagram_tokens enable row level security;
alter table instagram_messages enable row level security;

-- Token table: no policies at all, and no table privileges. Service role only.
revoke all on instagram_tokens from anon, authenticated;

-- Every member may see which account is connected (the lead page needs to
-- know); only the service-role connect/disconnect paths write it.
create policy instagram_connections_select on instagram_connections
  for select using (org_id = current_org_id());

-- Messages: visible to whoever can see the contact. Written only by the
-- service-role send/receive paths, which need the org's secret token.
create policy instagram_messages_select on instagram_messages
  for select using (
    exists (
      select 1
      from conversations cv
      join contacts c on c.id = cv.contact_id
      where cv.id = instagram_messages.conversation_id
        and can_access_contact(c.org_id, c.id, c.created_by)
    )
  );
