# Architecture

The living mental model of this codebase — how it's built, why it's shaped
this way, and where to look for something. Read this before making a
structural change; update it as part of any change that makes it wrong (see
[Keeping this current](#keeping-this-current) at the bottom).

Companions: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (target module map +
dependency rules), [`docs/domain-model.md`](docs/domain-model.md),
[`docs/integrations.md`](docs/integrations.md), [`docs/security.md`](docs/security.md),
[`docs/DECISIONS.md`](docs/DECISIONS.md) (the *why*).

## What this is

A multi-tenant CRM for lead-driven, WhatsApp-first, phone-heavy service
businesses (India first). Leads come mainly from Meta lead ads; WhatsApp is the
follow-up channel; meetings go on Google Calendar with Meet. Modular monolith:
one Next.js app, one Postgres database (Supabase), no separate backend.

**Stack:** Next.js 16 (App Router, Turbopack), React 19, Supabase (Postgres +
Auth via `@supabase/ssr`), Tailwind + shadcn/ui (Base UI primitives), Zod,
React Hook Form, Vitest (unit + DB-integration) and Playwright (e2e). Deploys
to Vercel + hosted Supabase, or as a Docker image (`output: "standalone"`).

> This codebase runs a newer/different Next.js than your training data
> reflects — `AGENTS.md` (imported by `CLAUDE.md`) points at the bundled docs
> in `node_modules/next/dist/docs/`. Check there before assuming an API.

## High-level design

### Layers (`src/lib`)

```
domain/        Pure business rules. No I/O, no framework, no other layer
               (enforced by ESLint). phone, contact identity, due/overdue in an
               org timezone, call outcomes, opportunity/stage rules, permissions,
               team invariants, WhatsApp window/status rules, meeting attendees.
ports/         Interfaces the core depends on: LeadSourceProvider,
               WhatsAppProvider, CalendarProvider.
services/      Application services (use-cases): DB + ports. One file per module.
integrations/  Adapters implementing ports (meta, whatsapp, google, mock).
               Never import services.
composition/   THE place that picks live vs. mock adapters per org.
security/      crypto (AES-GCM), signature (HMAC), oauth-state, rate-limit, limits.
observability/ JSON logger with request ids and secret redaction.
actions/       runAction(): the standard server-action error/revalidate contract.
auth/ supabase/  session resolution, redirect guard, Supabase clients.
```

Dependency rules are executable: `eslint.config.mjs` forbids `domain` importing
anything else, services importing concrete adapters (a shrinking allow-list:
`meta.ts`, `meta-backfill.ts`, `whatsapp.ts` — connection management), and
adapters importing services.

### Request lifecycle

**Read path** (any page): Server Component → `requireSession()` resolves who is
asking (user, org, role, **org timezone**) → `createClient()` (RLS-scoped, anon
key) → a `services/*.ts` function queries Postgres. No client-side data fetching
for initial page content.

**Write path** (any mutation): Client Component calls a `"use server"` action →
the action re-validates input with the same Zod schema the form used →
`requireSession()` / `requireRole([...])` → `runAction(name, body, pathsToRevalidate)`
runs one service function, which does the DB write *and* logs an `activities`
row → `revalidatePath` for every route showing the changed data.

`runAction` (in `src/lib/actions/run.ts`) is the single error contract: a
`UserError` (defined in `domain/errors.ts`) shows its message to the user; Next's
own control-flow throws (redirect/notFound) pass through via `unstable_rethrow`;
anything else is **logged in detail and shown as a generic message**, so
constraint names and column lists never reach the browser. Every action returns
`ActionResult<T> = { ok: true; data?: T } | { ok: false; error: string }`;
components branch on `.ok`, never on a thrown error.

**Inbound webhooks** (`src/app/api/webhooks/*`): request id → coarse IP rate
limit → verify signature over the *exact raw body* → parse → resolve the tenant
from the provider's account id → `webhook_receipts` insert (unique key = the
idempotency guarantee) → service → finish receipt → 200. See `docs/integrations.md`.

### Two Supabase identities — the security-critical asymmetry

1. **RLS-scoped client** (`supabase/server.ts` `createClient()`, cookies + anon
   key). Nearly everything uses it. RLS filters every query by org and role.
2. **Admin client** (`supabase/admin.ts`, service role, **bypasses RLS**). Only
   for: organization bootstrap, integration credentials (tables no client role
   can read), webhook ingestion (no user session), rate limiting, WhatsApp/calendar
   sends (which read tokens), and Auth admin calls. Every admin-client query
   filters `org_id` by hand — and the database backs that with composite foreign
   keys so a mistake can't create a cross-tenant reference.

### Multi-tenancy

Every business table carries `org_id`; RLS is the **hard** boundary. Composite
FKs `(org_id, x_id)` make cross-tenant references unstorable. `domain/permissions.ts`
mirrors the role rules in application code (UX and readable errors); if it ever
disagrees with RLS, RLS wins and the app is fixed. Roles: `admin` (= owner/admin),
`manager`, `salesperson`, per org in `organization_members`. Admin/manager see
everything; a salesperson sees leads assigned to or created by them **plus the
unassigned pool** (so they can claim). Salespeople cannot reassign a lead — a
trigger enforces it even against direct API calls (D-012).

### Contacts vs. opportunities

`contacts` is the person (normalized phone/email = dedupe keys, unique per org).
`leads` **is** the opportunity (kept name; D-002): stage (`lead_statuses`, under
`pipelines`), assignee, value, priority, `next_action_at`, `lost_reason`,
`first_contacted_at`, `closed_at`. The lead's name/phone/email columns are a
trigger-maintained display copy of the contact.

**`captureLead()` (`services/capture.ts`) is the only way a new lead is created**
— manual entry, the Meta webhook and backfill, and the test source all call it.
Replay → `duplicate`; a returning person with an open opportunity → `merged`
(timeline entry, no duplicate); otherwise create. Idempotency is
`lead_inquiries` + unique indexes, so concurrent deliveries create exactly one
lead.

**Assignment** of a new lead goes through an `AssignmentStrategy`
(`domain/assignment.ts`), chosen by `services/assignment.ts` from
`organizations.lead_assignment_mode`: `manual` (explicit assignee or the
unassigned pool) or `round_robin`. Round-robin applies where nobody is choosing
— Meta webhook/backfill, file import, the test source — never to manual entry.
An explicit assignee (including Meta's default assignee) always wins. The turn
is taken by `next_rotation_assignee()` under a row lock on
`assignment_rotation`, over active members with `in_rotation` (D-028).

### Time

Everything "today"/"overdue" is measured in `organizations.timezone` (default
`Asia/Kolkata`), never UTC and never the server's zone. `domain/due.ts` holds the
one rule (`classifyDue`, `zonedTimeToUtc`, `localDayBounds`) and SQL mirrors it
exactly (follow-up with a time is overdue at that instant; without one, at the
next org midnight). **Absolute timestamps shown to users go through
`src/lib/format.ts` with `session.timezone`** — `date-fns` `format()` uses the
runtime's zone (UTC on Vercel) and must not be used for that.

### Auth

Supabase Auth (email/password), `src/proxy.ts` refreshes the session and gates
routes (`PUBLIC_PATHS` matches whole path segments). `getSessionContext()` /
`requireSession()` / `requireRole()` in `src/lib/auth/session.ts` are the single
source of "who is asking". The login `redirectTo` and `/auth/confirm`'s `next`
pass through `safeRedirectPath` (open-redirect guard). Login, signup, password
reset and invitations are rate-limited (`security/limits.ts` holds the tunable
ceilings). Password reset: `/forgot-password` → emailed link → `/auth/confirm`
(exchanges the code for a session) → `/reset-password`.

### Organization + user lifecycle

`/signup` (closable with `SIGNUP_ENABLED=false`) is the only way an org comes
into existence: `createOrganizationWithAdmin()` (service role, by design —
there's no session before the org exists) creates the auth user, org, founding
`admin` membership, the default pipeline and its V1 stages, deleting the auth user
*and* org if any step fails. An admin adds people via `/team` →
`inviteMember({role: manager|salesperson})` (Supabase invite email); admins are
made by promotion (`setMemberRole`), never invitation. Deactivation is Supabase
Auth's ban (`setMemberActive`); `organization_members.is_active` is a display
mirror. Invariants (`domain/team.ts`): an org always keeps ≥ 1 active admin;
nobody deactivates themselves. Every team/settings/integration change writes an
`audit_events` row.

### The integration boundary pattern

Each external system is a **port** (`src/lib/ports/`) with a real adapter and a
mock adapter under `src/lib/integrations/<provider>/`, chosen per org by
`src/lib/composition/*` (live → demo → unavailable; mocks are off in production
unless `ENABLE_MOCK_PROVIDERS=true`). Adapters expose `config.ts` (env → typed
config or `null`, never throws at import), the adapter class, `mapping.ts`, and
`types.ts`. Services never import an adapter; server actions/routes obtain the
runtime from `composition/` and pass it in. Connection management (OAuth, token
storage, discovery) is in `services/meta.ts`, `services/whatsapp.ts`,
`services/calendar-connections.ts`.

| | Meta Ads | WhatsApp | Google Calendar |
|---|---|---|---|
| Port | `LeadSourceProvider` | `WhatsAppProvider` | `CalendarProvider` |
| Real adapter | `integrations/meta/` | `whatsapp/cloud-adapter.ts` | `google/calendar-adapter.ts` |
| Mock | `mock/lead-source.ts` | `whatsapp/mock-adapter.ts` | `google/mock-adapter.ts` |
| Inbound | `POST /api/webhooks/meta` (+ backfill) | `POST /api/webhooks/whatsapp` (messages, statuses) | — |
| Core service | `capture.ts` | `conversations.ts` | `meetings.ts` |

Calendars: an org has at most one *shared* `calendar_connections` row
(`user_id` null, admin-managed) and one *personal* row per member (managed from
`/settings`). `resolveCalendar(admin, orgId, target)` picks the connection that
already holds a meeting's event (`meetings.calendar_connection_id`), else the
host's personal calendar, else the shared one. A personal connection's
failures go on its own `last_error`, not `integration_health` (D-029).

WhatsApp: templates anytime; free text only within 24 h of the customer's last
message (`domain/whatsapp.ts`); consent recorded on the contact, `STOP` honoured;
failures are timeline events (`whatsapp_failed`), and only integration-level
failures mark the integration failing. Meetings: saved first, then the calendar
event is created under an id derived from the meeting (idempotent); a failed sync
sets `sync_error` and is retryable.

### Integration credentials — unreadable, and encrypted

`meta_user_tokens`, `meta_page_tokens`, `whatsapp_user_tokens`, `calendar_tokens`
(keyed by connection), and `assignment_rotation` (not a secret, but no client
needs it) have RLS **enabled with zero policies** and privileges `revoke`d from
`anon`/`authenticated` (Supabase exposes new public tables to the Data API by
default, so the revoke is not redundant). Values are additionally AES-256-GCM
encrypted (`security/crypto.ts`, `enc:v1:` prefix, `INTEGRATION_ENCRYPTION_KEY`;
legacy plaintext rows still decrypt and are re-encrypted on next write). A
token-isolation test guards every one; a fifth integration must add the same.

### Reporting

`services/dashboard.ts`: `getTodayQueue` (a person's own queue; "next lead" rule
in `domain/today.ts`) and `getOwnerDashboard` (managers/admins). Aggregates that
would exceed PostgREST's row cap run as SQL functions (`0008_reporting.sql`)
with **the caller's** privileges, so RLS still applies inside them.

## Low-level design

### Directory map

```
src/
  proxy.ts                        route gating + session refresh
  app/
    login/ signup/ forgot-password/ reset-password/ auth/confirm/   public auth
    (app)/                        authenticated shell (role-aware sidebar)
      page.tsx                    home: Today (salesperson) | owner dashboard (admin/manager)
      today/                      everyone's personal queue
      leads/ [id]/                list (filters), detail (call/WhatsApp/meeting actions, timeline)
      pipeline/ followups/ meetings/
      team/                       members, roles, lead-assignment mode + rotation
      settings/                   my calendar (everyone); org settings (incl. timezone) + integrations/
        integrations/             health overview, meta/, whatsapp/, google/
      actions.ts                  server actions (thin: validate → authorize → runAction → service)
    api/
      webhooks/{meta,whatsapp,mock-lead}/   provider deliveries (signature-verified, no session)
      integrations/{meta,whatsapp,google}/  OAuth connect + callback
      health/                     liveness (public, uninformative)
  components/ui/                  shadcn primitives (generated)
  components/crm/                 feature components, one folder per domain
  lib/                            layers above
supabase/
  migrations/                     schema (below)
  seed.sql                        demo org (India, IST) with every stage, calls, follow-ups, WhatsApp
tests/
  unit/                           Vitest — pure logic, adapters vs stubbed HTTP (no DB)
  integration/                    Vitest — real users vs. local Supabase
  e2e/                            Playwright — UI flows
Dockerfile, .dockerignore         standalone image; NEXT_PUBLIC_* are build args
```

### Database schema, by migration

| Migration | Adds |
|---|---|
| `0001_init_schema.sql` | `organizations`, `profiles`, `organization_members`, `lead_statuses`, `leads`, `notes`, `meetings`, `followups`, `activities` |
| `0002_functions_triggers.sql` | `set_updated_at()`, `handle_new_user()`, RLS helpers `current_org_id()`, `current_org_role()`, `is_org_member()` |
| `0003_rls_policies.sql` | RLS + policies, `can_access_lead()` |
| `0004_meta_ads_integration.sql` | Meta connection/pages/forms/attribution/webhook events/backfill; token tables (locked) |
| `0005_whatsapp_integration.sql` | WhatsApp connections, numbers, templates, messages; token table (locked) |
| `0006_org_onboarding.sql` | one org per user; `is_active` |
| `0007_v1_domain_model.sql` | `contacts`, `pipelines`, opportunity fields on `leads`, `call_logs`, `lead_inquiries`, `audit_events`, `integration_health`, `webhook_receipts`, `rate_limits`; org timezone/country/currency; composite org-consistency FKs; triggers (lead↔contact copy, `closed_at`, `next_action_at`, assignment guard, timeline `contact_id`); capture RPCs; unassigned-pool visibility; drops the unused `integration_settings` |
| `0008_reporting.sql` | `dashboard_stage_counts`, `dashboard_source_breakdown`, `dashboard_rep_activity` (security invoker) |
| `0009_whatsapp_conversations.sql` | `conversations`; inbound/status/consent columns; unique provider message id and unique number-per-org |
| `0010_calendar.sql` | `calendar_connections`, `calendar_tokens` (locked), meeting provider/event/`sync_error`, `meeting_attendees` |
| `0011_round_robin_and_personal_calendars.sql` | `organizations.lead_assignment_mode`, `organization_members.in_rotation`, `assignment_rotation` (locked) + `next_rotation_assignee()`; `calendar_connections.user_id` (shared vs personal, partial unique indexes), `last_error`; `calendar_tokens` keyed by `connection_id`; `meetings.calendar_connection_id` |

`activities` is append-only and **`logActivity()` is its only writer**.

### Conventions worth knowing before you add code

- **Services take an untyped `SupabaseClient`** — new tables type-check without
  regenerating `database.types.ts`; still run `npm run db:types` after a migration
  and `npx tsc --noEmit`.
- **Two foreign keys between a parent and child** (the plain `lead_id` FK used
  for embeds, and the composite `(org_id, lead_id)` FK for integrity) make
  one-to-many PostgREST embeds ambiguous. Name the relationship:
  `followups!followups_lead_id_fkey(...)`, `contacts!leads_org_contact_fkey(*)`.
  This only fails at **runtime** — `tsc` can't see it; the integration suite does.
- **`UserError`** for anything a person should read; everything else is logged and
  hidden. Services throw; actions wrap in `runAction`.
- **Org-timezone display**: `formatDateTime(iso, session.timezone)`; never
  `date-fns format` on a timestamp.
- **Links vs. buttons**: a navigation target is `<Link>/<a>` styled with
  `buttonVariants()`. Base UI's `Button render={<Link/>}` is exposed to assistive
  tech as `role="button"`.
- **Domain files use relative imports** (the lint rule bans `@/…` there).
- **`whatsapp_messages`** keeps its name but is the Message table.
- **Base UI `Button`** with a non-`<button>` `render` needs `nativeButton={false}`.

### Testing strategy

Three levels (see README for commands):

1. **Unit (Vitest, `tests/unit`)** — `domain/*`, adapters against stubbed `fetch`,
   parsers, crypto, logger, search-clause builder. No database, milliseconds.
2. **Integration (Vitest, `tests/integration`)** — real signed-in users against the
   local database. Tenant isolation, every role on sensitive operations, capture
   and webhook idempotency (including concurrent deliveries), WhatsApp send/receive/
   status/window/consent, meetings + calendar, dashboards reflecting changes, the
   whole lead-to-Won lifecycle in a fresh org. `server-only` is aliased to a no-op
   so services can be imported directly. Tests are re-runnable without a reset.
   The route handlers are invoked directly (`POST(new NextRequest(...))`).
3. **E2E (Playwright, `tests/e2e`)** — the UI: V1 happy path, Today/dashboards,
   auth (incl. a real password reset read from Mailpit), WhatsApp demo mode,
   onboarding, Meta ingestion. `playwright.config.ts` raises the login/signup/reset
   rate limits for its own server only.

Gotchas: seeded ids aren't stable across `db:reset` (look up by slug
`summit-sales-group`); a `page` already signed in can't visit `/login` as someone
else (use `browser.newContext()`); auth-heavy tests are slow (`test.slow()`);
after clicking a link, wait for the URL before filling a field the old page also
has; Vitest under `NODE_ENV=test` skips `.env.local` (see
`tests/support/load-env.ts`).

## Known gaps

- No CSP header; no MFA; encryption-key rotation is manual (`docs/security.md`).
- One WhatsApp number per org.
- Inbound WhatsApp from an unknown number is logged, not turned into a lead.
- Meta long-lived tokens aren't proactively refreshed.
- No automation/workflow engine, load-based routing, or ad-spend data (V2).
- `meta_webhook_events` (Meta's delivery log, used by the admin UI) and
  `webhook_receipts` (idempotency for later providers) are two logs; consolidating
  is a V2 cleanup.
- Kanban drag-and-drop is mouse-only.
- Meta/WhatsApp *connection-management* services still import concrete Graph
  clients (allow-listed in ESLint); the messaging/capture paths are fully behind
  ports.

## Keeping this current

This file goes stale the moment architecture changes and nobody updates it —
that's worse than not having it, because a wrong mental model is trusted more
than no mental model. Update it as part of the same change (not a follow-up)
whenever you:

- Add or change a database migration (update the migration table, and the
  prose if it's a new domain, not just a new column).
- Add a new integration, or change an existing one's shape (new webhook, new
  OAuth scope, new token table, new port).
- Add a new service file, a new top-level route, or a new role/permission.
- Change the request lifecycle pattern (e.g. if `ActionResult` or `runAction`
  changes shape).
- Fix something listed under [Known gaps](#known-gaps) — remove it there.

If a change is small enough that none of the above apply, it probably doesn't
need an update — this file describes the current shape, not the history (that's
what `git log` is for).
