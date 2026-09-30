# Decisions

Architecture Decision Records for the V1 build. Newest last. Any removal or
behaviour change to existing functionality is recorded here with its reason.

Status values: **Accepted**, **Superseded**, **Proposed**.

---

## D-001 — Keep Next.js + Supabase; do not adopt NestJS / Prisma / a monorepo
**Status:** Accepted · 2026-09-19

**Context.** The V1 brief recommends pnpm workspaces, NestJS, Prisma. It also
says *not* to replace working technology merely because another would be
preferable, and to prefer incremental refactoring. The repo is a working
Next.js 16 + Supabase (Postgres, Auth, RLS) modular monolith with ~6k lines
of service/integration code and a deployment target of Vercel + hosted
Supabase.

**Decision.** Keep the stack. Preserve the brief's *module / domain /
application / infrastructure separation* inside `src/lib` (see
[ARCHITECTURE.md](ARCHITECTURE.md)) and enforce it with lint rules.

**Why this is better for V1.**
- Tenant isolation is enforced **in the database** (RLS), so a forgotten
  `where org_id = …` in application code cannot leak data. Prisma connects as
  a single privileged role and bypasses RLS unless every query is wrapped in
  a transaction that sets session variables — a rewrite that *weakens* the
  strongest existing guarantee.
- One deployable, one language, no second service to run, secure, and pay
  for. Matches "boring, reliable, low operational cost".
- A rewrite would spend the budget re-implementing OAuth, webhook signing,
  RLS and onboarding that already work and are tested.

**Consequences.** No OpenAPI/Swagger (D-004). "Guards/policies" are RLS +
the `permissions` matrix + service-level checks. If a public REST API is ever
needed, add route handlers over the same services.

---

## D-002 — Opportunity = `leads` table, Stage = `lead_statuses`; add `contacts` and `pipelines`
**Status:** Accepted · 2026-09-19

**Context.** The brief requires Contact ≠ Opportunity. Today `leads` holds
person fields *and* the sales attempt. Six tables (`notes`, `meetings`,
`followups`, `activities`, `whatsapp_messages`, `meta_lead_attribution`),
RLS policies, the Kanban, and ~40 queries reference `leads.id` / `lead_id`.

**Decision.** Additive migration, no rename:
- New `contacts` (person/business) with normalized phone/email and per-org
  unique dedupe keys.
- `leads` **is** the Opportunity. It gains `contact_id`, `pipeline_id`,
  `value`, `priority`, `next_action_at`, `lost_reason`. Its person columns are
  kept during the transition and treated as a denormalized display copy that
  `captureLead` keeps in sync with the contact.
- `lead_statuses` **is** PipelineStage; it gains `pipeline_id` under a new
  `pipelines` table.
- Domain code uses the names `Contact`, `Opportunity`, `PipelineStage`
  (type aliases in `src/lib/domain`); the physical names appear only in the
  data-access layer.

**Why not rename the tables.** A physical rename touches every query, RLS
policy and generated type in one change, with no user-visible benefit and a
large regression surface. The alias layer gives the domain vocabulary the
brief asks for while every existing page keeps working. Revisit as a
mechanical rename in V2 if it proves confusing.

**Consequences.** UI copy keeps saying "Lead" for an opportunity in an early
stage — accurate in this market. Documented in `domain-model.md`.

---

## D-003 — Role names
**Status:** Accepted

`admin` = brief's **OWNER/ADMIN**, `manager` = MANAGER, `salesperson` =
SALESPERSON. The org's founding user is `admin`. No rename of the stored
value (constraint, RLS and ~20 call sites use it). Slice 6 allows more than
one admin and role changes.

---

## D-004 — No separate REST API / OpenAPI in V1
**Status:** Accepted

The browser talks to server actions and Server Components; external systems
talk to a small, fixed set of route handlers (webhooks, OAuth). There is no
third-party-facing API to document. "Calling the API directly" for isolation
testing means calling Supabase's PostgREST endpoint with a user's JWT — that
is tested (Slice 2) and is the harder case, since RLS is the only barrier
there. The HTTP surface is documented in `docs/integrations.md`.

---

## D-005 — Two architecture documents, different jobs
**Status:** Accepted

`CLAUDE.md` mandates the root `ARCHITECTURE.md` as the *as-built* mental
model, updated with every structural change. The brief asks for
`docs/ARCHITECTURE.md`. On Windows/macOS `docs/architecture.md` and
`docs/ARCHITECTURE.md` are the same file, so the brief's two names collapse
into one.

**Decision.** Root `ARCHITECTURE.md` = as-built reference (unchanged role).
`docs/ARCHITECTURE.md` = target module map and **dependency rules**, plus
links to the as-built file. Neither duplicates the other's content.

---

## D-006 — Vitest for unit/DB-integration tests; keep Playwright for E2E
**Status:** Accepted

There is no unit runner; pure-function tests currently live inside Playwright
specs. Add **Vitest** (dev dependency, no runtime impact) with two projects:
`unit` (pure `domain/` + adapters with fake clients, no network) and
`integration` (signs in as real seeded users against local Supabase and
asserts RLS / service behaviour). Existing Playwright specs stay; the
pure-function ones may be moved over later, not now.

`server-only` imports throw outside Next; services that need testing are
either exercised through the DB with the anon/user client (RLS tests) or have
their pure logic in `domain/`. Vitest aliases `server-only` to a no-op so
services can be imported directly in the integration project.

---

## D-007 — Org timezone; wall-clock follow-ups
**Status:** Accepted

`organizations.timezone` (IANA, default `Asia/Kolkata`). A follow-up's
`due_date` + `due_time` are **wall-clock in the org's timezone** (that is how
a salesperson thinks: "call at 4 pm"), and "today / overdue / due-now" are
computed by a pure function `classifyDue(due, now, tz)`.
- *Overdue* = due instant already passed (date earlier than today in org tz,
  or today with a time earlier than now). A follow-up due today with **no**
  time is *due today* until the end of the day.
- Replaces the UTC `toISOString().slice(0,10)` logic (defect #2).

---

## D-008 — Queue: interface now, inline implementation
**Status:** Accepted

Webhooks must return fast and be retry-safe. At V1 volume (a 3–30 person
business) Vercel functions can process a delivery inline, so **no Redis /
BullMQ**. `JobQueue` (a port) exists with an `InlineJobQueue` implementation
so handlers are written as idempotent jobs; swapping in a real queue later
does not change handler code. Idempotency comes from `webhook_receipts` (a
unique key per provider event), not from queue semantics.

---

## D-009 — Integration credentials: app-level AES-256-GCM
**Status:** Accepted

Tokens are already unreadable to clients (RLS with no policies + revoked
privileges). Add encryption at rest so DB dumps/backups/service-key leaks
don't disclose them. `INTEGRATION_ENCRYPTION_KEY` (32 bytes, base64) in env;
values stored as `enc:v1:<iv>:<tag>:<ciphertext>`. Reads accept legacy
plaintext (no prefix) and the next write re-encrypts, so it deploys with no
downtime and no data migration script. Key rotation: prefix carries a version
(`v1`); add `v2` + keep both decryptable.

Not using Supabase Vault: it ties the design to a Supabase-only extension,
while an env key works on any Postgres (the brief wants a container-friendly,
provider-replaceable deployment).

---

## D-010 — Rate limiting in Postgres
**Status:** Accepted

Vercel functions are stateless; an in-memory limiter is per-instance and
nearly useless. A `rate_limits` table + `rate_limit_hit(key, window, max)`
function (service-role only, atomic upsert) gives a correct cross-instance
fixed-window limiter with no new infrastructure. Applied to signup, invite,
password reset, webhook endpoints (post-signature-check, keyed by provider +
org, and by IP before it), and mock-source endpoint. Login rate limiting is
Supabase Auth's own.

---

## D-011 — Remove `integration_settings`, `supabase/client.ts`, and `SchedulingProvider`
**Status:** Accepted — **done** (2026-09-20)

`integration_settings` (migration 0001) is read by nothing (only a comment in
`scheduling/index.ts` mentions it); each integration grew dedicated tables.
`src/lib/supabase/client.ts` (browser client) is imported nowhere. Both are
removed to prevent a second, competing place for integration config. Dropped
in migration 0007; no data to preserve (verified unused). Also removed:
`src/lib/integrations/scheduling/` (`SchedulingProvider` + `CalendlyProvider`) —
nothing imported it (the schedule dialog reads the org's Calendly URL directly),
and the `CalendarProvider` port supersedes it. The Calendly booking URL setting
and link-out button remain.

---

## D-012 — Assignment is a manager/admin action
**Status:** Accepted — **behaviour change**

Previously any salesperson could reassign any lead they could see. Because
RLS visibility follows assignment/creation, reassigning silently removes the
lead from the actor's own view and lets one rep dump work on another. V1:
**admin and manager assign/reassign; a salesperson may claim an unassigned
lead** (assign to self). Salespeople keep full control of stage, calls,
tasks, notes, WhatsApp and meetings on leads they can see. Encoded in the
`permissions` matrix and tested per role.

---

## D-013 — Default pipeline applies to new orgs (and seed); existing orgs untouched
**Status:** Accepted

V1 default: New Lead → Contact Needed → Contacted → Interested → Meeting
Scheduled → Meeting Completed → Payment Pending → Won, plus Lost. Stages are
per-org data; rewriting an existing org's stages could orphan its leads'
meaning. The migration creates one `pipelines` row per existing org and
attaches its current stages; only **new** orgs and the demo seed get the V1
stage set. Stage semantics the app relies on are flags, not names:
`is_default` (entry stage), `is_won`, `is_lost`.

---

## D-014 — "Shared business number" = one WhatsApp number per organization
**Status:** Accepted

The brief's shared number maps to the existing per-org WhatsApp connection
(admin connects the org's WABA number; every salesperson sends from it).
The connection is per organization, **not** one platform-wide number, so
tenants stay isolated and each business uses its own verified number.
Conversations are keyed `(org_id, contact_id, channel)`.

---

## D-015 — Google Calendar: org-level OAuth connection in V1
**Status:** Accepted

An admin connects one Google account per org; events are created on that
account's calendar with the salesperson and contact as attendees and
`conferenceData` requesting a Meet link. Per-salesperson calendars require
per-user OAuth and consent for every rep — a V2 extension. The
`CalendarProvider` interface takes a connection id so per-user connections
slot in without an interface change. Calendly link-out stays as the
"manual link" provider for orgs without Google. *Extended by D-029.*

---

## D-016 — Calls are recorded manually
**Status:** Accepted

`tel:` link + post-call outcome form. Outcomes (enum, DB check constraint):
`connected_interested`, `no_answer`, `follow_up`, `meeting`,
`not_interested`, `wrong_number`. No telephony, recording, or transcription.
Outcome → suggested next step is a pure function (`domain/calls.ts`) so the
UI, not a workflow engine, offers "schedule follow-up".

---

## D-017 — Mock providers are explicit, never silent in production
**Status:** Accepted

Every port has a `mock` adapter for demo/dev/test. The composition root picks
adapters from config: real credentials present → real adapter; else if
`ENABLE_MOCK_PROVIDERS=true` → mock. In `NODE_ENV=production` mocks are
**off unless explicitly enabled**, and the Integrations page labels any
mock-backed connection "Demo mode", so nobody believes a WhatsApp message was
delivered when a mock accepted it.

---

## D-018 — Signup gate
**Status:** Accepted

`SIGNUP_ENABLED` (default `true` in dev, must be set in production) allows a
design-partner deployment to close public org creation while keeping the flow
for self-serve use.

---

## D-019 — Unassigned leads are a pool every salesperson can see and claim
**Status:** Accepted — amends D-012 · 2026-09-20

D-012 lets a salesperson *claim* an unassigned lead. Under the original RLS a
salesperson could not see one, so the rule was dead code. `can_access_lead()` now
also returns true when `assigned_to is null` (and `can_access_contact` follows).
Once assigned, a lead is visible only to its owner and creator, as before;
admins/managers see everything. The domain mirror `canAccessLead` and the list
scoping changed together, and a test pins each.

**Consequence.** Meta leads that arrive with no default assignee are visible to
the whole sales team until someone claims them, which is what a small team wants
and matches "Manual assignment in V1".

---

## D-020 — Meetings: save first, sync second, idempotent event id
**Status:** Accepted

A meeting is inserted before the calendar call. The calendar event is created
under an id derived from the meeting id (Google accepts a client-chosen id, so a
retry hits 409 and fetches the event instead of double-booking). If the call
fails the meeting is kept with `sync_error`, the timeline says so, the UI shows a
warning and a *Retry* button, and nothing claims an invitation was sent. Cancel
still cancels the meeting if the calendar removal fails (it *was* cancelled); the
error is kept on the row.

---

## D-021 — Inbound WhatsApp from an unknown number does not create a contact
**Status:** Accepted

A stranger messaging the shared number is recorded as `unmatched` on the webhook
receipt and shown on the Integrations page. Turning it into a lead is a
lead-capture decision (click-to-WhatsApp ads) with its own consent and spam
implications, so it is V2 — the seam is the `unmatched` branch in
`services/conversations.ts`, which would call `captureLead`.

---

## D-022 — Rate-limit ceilings are code defaults, overridable by environment
**Status:** Accepted

Login (per IP, per account), signup, password reset and invitations are limited
by the Postgres limiter (D-010). Defaults live in `src/lib/security/limits.ts`;
each has an env override so an automated test server that signs in dozens of times
a minute can raise its own limits (`playwright.config.ts`) without weakening
production. Signup, reset and invitations **fail closed** if the limiter is down;
login and webhooks fail open (locking every user out, or dropping a customer's
lead, is the worse failure).

---

## D-023 — Keep `meta_webhook_events` alongside `webhook_receipts`
**Status:** Accepted (revisit in V2)

Meta Lead Ads already has a working delivery log with an admin UI and backfill
relation. New providers use the generic `webhook_receipts` idempotency table.
Two logs is duplication, accepted to avoid a risky rewrite of a tested flow;
consolidating them is a V2 cleanup.

---

## D-024 — The V0 lead-workflow e2e spec is replaced
**Status:** Accepted

`tests/e2e/lead-workflow.spec.ts` asserted V0 labels ("Change Status",
"Converted") and was known-flaky (`router.refresh()` racing `router.push()` in the
add-lead dialog). The race is fixed in the dialog (the action already
revalidates, so it only navigates), and the spec now covers the V1 flow. The
seven-stage V0 default pipeline is replaced **for new orgs and the seed** by the
V1 nine-stage pipeline (D-013); existing orgs keep their stages.

---

## D-025 — Open-redirect guard and link semantics
**Status:** Accepted

Found during the build: `login` passed the form's `redirectTo` straight to
`redirect()` (an open redirect). All post-auth redirects now go through
`safeRedirectPath` (same-origin paths only). Separately, navigation targets are
real links (`<Link>`/`<a>` styled with `buttonVariants`) because Base UI's
`Button render={<Link/>}` announces `role="button"` to assistive technology.

---

## D-026 — CSV file upload as a fourth lead-capture path
**Status:** Accepted · 2026-09-22

**Context.** Requested post-V1: an admin should be able to bulk-import leads
from a spreadsheet (an event list, an old sheet, an export from another tool)
from Settings → Integrations.

**Decision.** Not a `LeadSourceProvider` adapter — there's no ongoing
connection to verify, poll or show health for the way Meta or a webhook has;
it's a one-off admin action. `services/file-import.ts` parses the file
(`domain/csv-import.ts`, pure, unit-tested) and calls the same `captureLead`
every other source uses, once per row, under the uploading admin's own
session — exactly like manual entry, so RLS and the permission matrix apply
unchanged. A `source` column is matched case-insensitively against
`LEAD_SOURCES`; anything else is kept as `Other` with the original text as
`sourceDetail` rather than rejected. A bad phone doesn't fail the row
(`strictPhone: false`, as webhooks already do) since one bad cell in a
500-row file shouldn't sink the other 499.

**Idempotency.** Re-uploading the same file is safe for a different reason
than a webhook retry: there's no event id to dedupe on, but `captureLead`'s
identity dedupe (step 2, by normalized phone/email) already merges a repeat
row into the opportunity it created the first time, so nothing extra was
needed.

**Consequences.** `integration_health` gained a `file_upload` provider row
(service-role write, per the existing no-authenticated-write-policy on that
table) so a bad or all-invalid file is visible on the Integrations page like
any other source's failure. Limits: 1,000 rows / 2 MB per upload — generous
for a manual list, small enough to run inline in one request without a queue.
Admin-only (`permissions.canConnectIntegrations`), matching every other row
on that settings page.

**Real-world exports, not just clean CSVs.** The delimiter is sniffed from the
header line (comma, tab or semicolon), because a sheet pasted as text or saved
from Excel is often tab-separated, not comma-separated — the importer accepts
`.csv`/`.tsv`/`.txt`. A leading `p:` on a phone number (how Meta's own lead-form
exports and several lead-gen tools write it) is stripped before capture. Column
matching ignores spaces/underscores/case and unmapped columns (survey answers,
an export tool's own status fields) are silently dropped, so a business's raw
export usually works without pre-editing it.

---

## D-027 — CI runs the full gate; Vercel's own Git integration stays the deploy mechanism
**Status:** Accepted · 2026-09-23

**Context.** The audit's top P0 finding: no CI at all — lint/typecheck/tests/build
only ran when a human remembered to. Separately, Vercel's dashboard Git
integration is already connected to this repo and already deploys every push
to `main` to production, independent of anything in `.github/`.

**Decision.** `.github/workflows/ci.yml` runs the project's own documented
quality gate (`lint`, `typecheck`, `test`, `test:integration` against a real
local Supabase started in the runner, `test:e2e`, `build`) on every push and
pull request against `main`. It does **not** also deploy. An earlier draft of
this workflow added a second, Actions-driven deploy job (`vercel pull` /
`vercel build` / `vercel deploy --prebuilt --prod`) before it was confirmed
that Vercel's Git integration was already live — running both would race two
independent deploys of the same push. Deployment stays exactly one mechanism:
Vercel's own.

**Consequence.** This workflow does not, by itself, stop broken code from
reaching production — Vercel deploys whatever lands on `main` regardless of
whether this workflow passed. The actual gate is branch protection on `main`
requiring the `quality` check to pass before a PR can merge (configured in
GitHub repo settings, not in code); until that's turned on, this workflow is
observability (you'll see red), not enforcement. If Vercel's Git integration
is ever disconnected, the deploy job from the earlier draft is the one to
bring back — it needs `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` as
repo secrets and nothing else, since it pulls the app's real env vars from
Vercel's own Production environment rather than duplicating them into GitHub.

---

## D-028 — Round-robin assignment: org mode + per-member rotation, turns taken in SQL
**Status:** Accepted

**Context.** Meta leads and file imports arrive with no one choosing an
assignee, so under V1 they sat in the unassigned pool until someone claimed
them.

**Decision.** `organizations.lead_assignment_mode` is `manual` (default) or
`round_robin`; `organization_members.in_rotation` says who takes turns
(salespeople by default, managers/admins opt in). `roundRobinAssignment` is a
second `AssignmentStrategy`; the turn itself is `next_rotation_assignee(org)`,
which locks the org's `assignment_rotation` row, picks the next active,
in-rotation member by user id after the last one (wrapping), and records it —
so concurrent webhook deliveries get distinct consecutive turns. An explicit
assignee (a person's choice, or Meta's default assignee) always wins and does
not consume a turn. Merged/duplicate captures never reach the strategy, so they
don't consume turns either.

It applies where no person is choosing: Meta webhook + backfill, file import,
the test source. Manual entry keeps its assignee picker — auto-assigning there
would surprise the person typing, and would violate the rule that a
salesperson may only assign a new lead to themselves.

**Consequence.** Order is by user id, not join date — stable and cheap, but not
something the admin can reorder. A turn is consumed even if the lead insert
later fails (rare; it just skips someone once). Load-based routing would be a
third strategy, not a change to this one.

---

## D-029 — Per-salesperson calendars: personal connections beside the shared one
**Status:** Accepted

**Context.** With one org-level Google account (D-015), every invitation came
from the same shared calendar, and reps' own calendars didn't show their
meetings.

**Decision.** `calendar_connections.user_id` null = the org's shared calendar
(admin-managed, at most one); set = that member's personal calendar (at most
one each, managed by the member from Settings). Tokens are keyed by
connection. A new meeting goes on its host's personal calendar if connected,
else the shared one (`composition/calendar.ts`). `meetings.calendar_connection_id`
records which connection holds the event, so reschedule/cancel always hit the
same calendar even if the host connects or disconnects later. The OAuth state
carries a signed `personal` flag. A personal connection's failures go on its
own row (`last_error`) — one rep's revoked grant must not mark the org's
calendar integration as failing; the shared one still reports through
`integration_health`.

**Consequence.** Disconnecting a calendar leaves its events in Google but
unlinks them (`calendar_connection_id` → null), so later changes to those
meetings no longer reach the calendar. For a Google app in "Testing", every
rep who connects must be listed as a test user.
