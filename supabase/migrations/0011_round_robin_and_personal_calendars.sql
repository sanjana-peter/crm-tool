-- Two V2 features that V1 left seams for (docs/v1-scope.md):
--
--  1. Round-robin lead assignment — a new `AssignmentStrategy`
--     (src/lib/domain/assignment.ts). The org chooses manual or round-robin;
--     each member is in or out of the rotation; `next_rotation_assignee()`
--     hands out turns under a row lock so concurrent webhook deliveries never
--     give the same turn twice.
--
--  2. Per-salesperson calendars — `calendar_connections` was one row per org.
--     Now there is at most one *shared* connection (user_id null) and at most
--     one *personal* connection per member. A meeting goes on its host's own
--     calendar when they have connected one, else on the shared one, and it
--     remembers which connection holds its event so a reschedule or cancel
--     always goes to the same calendar.

-- ============================================================================
-- 1. Round-robin assignment
-- ============================================================================
alter table organizations
  add column lead_assignment_mode text not null default 'manual'
    check (lead_assignment_mode in ('manual', 'round_robin'));

alter table organization_members
  add column in_rotation boolean not null default false;

-- Salespeople are the natural rotation; admins/managers opt in from /team.
update organization_members set in_rotation = true where role = 'salesperson';

-- Whose turn was last, per org. Service role and the function below only.
create table assignment_rotation (
  org_id uuid primary key references organizations (id) on delete cascade,
  last_user_id uuid references profiles (id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table assignment_rotation enable row level security;
revoke all on assignment_rotation from anon, authenticated;

-- The next active, in-rotation member after the last one (ordered by user id,
-- wrapping around), and records the turn. The row lock serializes callers per
-- org, so N concurrent captures produce N distinct consecutive turns.
-- Service-role callers (auth.uid() is null: webhooks, backfill) may act for
-- any org; a signed-in caller must be an admin/manager of that org (file
-- import runs under the admin's own session).
create function next_rotation_assignee(p_org uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last uuid;
  v_next uuid;
begin
  if auth.uid() is not null
     and (p_org is distinct from current_org_id() or current_org_role() not in ('admin', 'manager')) then
    raise exception 'not allowed to assign leads in this organization' using errcode = '42501';
  end if;

  insert into assignment_rotation (org_id) values (p_org) on conflict (org_id) do nothing;
  select last_user_id into v_last from assignment_rotation where org_id = p_org for update;

  select m.user_id into v_next
  from organization_members m
  where m.org_id = p_org and m.in_rotation and m.is_active
    and (v_last is null or m.user_id > v_last)
  order by m.user_id
  limit 1;

  if v_next is null then
    select m.user_id into v_next
    from organization_members m
    where m.org_id = p_org and m.in_rotation and m.is_active
    order by m.user_id
    limit 1;
  end if;

  if v_next is not null then
    update assignment_rotation set last_user_id = v_next, updated_at = now() where org_id = p_org;
  end if;

  return v_next;
end;
$$;

revoke all on function next_rotation_assignee(uuid) from public, anon;
grant execute on function next_rotation_assignee(uuid) to authenticated, service_role;

-- ============================================================================
-- 2. Per-salesperson calendars
-- ============================================================================
alter table calendar_connections drop constraint calendar_connections_org_id_key;

alter table calendar_connections
  add column user_id uuid,
  -- The last failure of a *personal* connection (a shared one reports through
  -- integration_health instead), so its owner can see it needs reconnecting.
  add column last_error text check (last_error is null or length(last_error) <= 500),
  add column last_error_at timestamptz,
  add constraint calendar_connections_org_member_fkey
    foreign key (org_id, user_id) references organization_members (org_id, user_id) on delete cascade,
  add constraint calendar_connections_org_id_id_key unique (org_id, id);

create unique index idx_calendar_connections_shared on calendar_connections (org_id) where user_id is null;
create unique index idx_calendar_connections_personal on calendar_connections (org_id, user_id) where user_id is not null;

-- Tokens were keyed by org; key them by connection instead.
alter table calendar_tokens add column connection_id uuid;
update calendar_tokens t
  set connection_id = c.id
  from calendar_connections c
  where c.org_id = t.org_id and c.user_id is null;
delete from calendar_tokens where connection_id is null;

alter table calendar_tokens drop constraint calendar_tokens_pkey;
alter table calendar_tokens alter column connection_id set not null;
alter table calendar_tokens add primary key (connection_id);
alter table calendar_tokens
  add constraint calendar_tokens_connection_fkey
    foreign key (org_id, connection_id) references calendar_connections (org_id, id) on delete cascade;
create index idx_calendar_tokens_org on calendar_tokens (org_id);

-- Which connection holds a meeting's calendar event.
alter table meetings
  add column calendar_connection_id uuid,
  add constraint meetings_calendar_connection_fkey
    foreign key (org_id, calendar_connection_id) references calendar_connections (org_id, id)
    on delete set null (calendar_connection_id);

-- Every Google event created before this migration lives on the shared calendar.
update meetings m
  set calendar_connection_id = c.id
  from calendar_connections c
  where c.org_id = m.org_id and c.user_id is null
    and m.provider = 'google' and m.external_event_id is not null;

-- An admin manages the shared connection; each member manages their own.
drop policy calendar_connections_admin_write on calendar_connections;
create policy calendar_connections_write on calendar_connections
  for all using (
    org_id = current_org_id()
    and ((user_id is null and current_org_role() = 'admin') or user_id = auth.uid())
  )
  with check (
    org_id = current_org_id()
    and ((user_id is null and current_org_role() = 'admin') or user_id = auth.uid())
  );
