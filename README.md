# Summit CRM

A radically simple CRM and sales-execution tool for **WhatsApp-first, phone-heavy
service businesses in India** (education consultancies and similar lead-driven
teams of 3–30 people), built to expand internationally.

> **Capture every lead, make the next action obvious, keep calls / WhatsApp /
> meetings in one timeline, and show the owner what needs attention.**

A salesperson opens the app and sees *work to do*, not charts. An owner opens
one screen and sees what is being neglected.

## What it does (V1)

| | |
|---|---|
| **Capture** | Manual entry, Meta Lead Ads (real webhook + backfill), and a credential-free test source. All three go through one `captureLead` service: phone/email normalized, people deduped, replays idempotent. |
| **Pipeline** | Contacts ≠ Opportunities. Default pipeline *New Lead → Contact Needed → Contacted → Interested → Meeting Scheduled → Meeting Completed → Payment Pending → Won*, plus *Lost* (reason required). List + Kanban. |
| **Salesperson "Today"** | New leads to contact first, overdue vs. due-later-today follow-ups, today's meetings, and a *Start next lead* button. "Today"/"overdue" use the organization's timezone (IST by default). |
| **Calls** | Tap-to-call (`tel:`), then record the outcome, duration, notes and the next follow-up in one step. No telephony or recording. |
| **WhatsApp** | Shared business number via the official Cloud API: templates, free-text replies inside the 24-hour window, inbound messages, delivery receipts, opt-out (`STOP`) handling, failures surfaced. |
| **Meetings** | Google Calendar + Meet through a provider interface (Calendly link-out kept as a fallback). Saved first, then synced; a failed sync is shown and retryable. |
| **Owner dashboard** | Uncontacted leads, overdue follow-ups, pipeline counts, meetings, per-rep activity, lead sources. Exact aggregates in SQL. |
| **Team & security** | Owner/Admin, Manager, Salesperson; invitations with a role; role changes that can never orphan an org; password reset; audit log. |
| **Integration health** | One page: Meta, WhatsApp and Google as connected / failing / disconnected / demo, with the last safe error. |

Out of scope on purpose (see [`docs/v1-scope.md`](docs/v1-scope.md)): telephony,
call recording, automation/workflow engines, payments,
email marketing, funnels, BI, native apps.

## Demo mode

With **no provider credentials at all** the app still demonstrates the whole
product: WhatsApp, Google Calendar and lead ingestion fall back to clearly
labelled *mock* adapters (`ENABLE_MOCK_PROVIDERS`, on outside production, off in
production). A mock WhatsApp send is recorded but **never delivered** and says so
everywhere. Add real credentials and the same code paths use the real adapters —
no rewrite.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Supabase (Postgres + Auth +
Row Level Security) · Tailwind + shadcn/ui · Zod · Vitest · Playwright.
A modular monolith: one deployable, one database. Why not NestJS/Prisma:
[`docs/DECISIONS.md`](docs/DECISIONS.md) D-001.

## Quick start

Prerequisites: Node 22, [Docker Desktop](https://www.docker.com/products/docker-desktop/) (running).

```bash
npm install
cp .env.example .env.local
npm run db:start          # starts local Supabase; prints the URL and keys
# paste NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and
# SUPABASE_SERVICE_ROLE_KEY (as printed) into .env.local
npm run db:reset          # applies every migration + seeds the demo org
npm run dev               # http://localhost:3000
```

### Demo logins (password `password123`)

| Email | Role | Lands on |
|---|---|---|
| `admin@summitsales.test` | Admin (owner) | Owner dashboard: what needs attention |
| `manager@summitsales.test` | Manager | Owner dashboard (+ *My Today*) |
| `jordan@summitsales.test` | Salesperson | *Today* work queue |
| `priya@summitsales.test`, `marcus@summitsales.test` | Salesperson | *Today* work queue |

The seed is an education consultancy in India: ~19 leads across every stage,
Meta-ad attribution, calls, follow-ups (overdue / due later today / upcoming),
meetings today and tomorrow, a live WhatsApp conversation, and approved demo
message templates.

**Try the lead-to-sale flow:** sign in as Jordan → *Start next lead* → **Call** →
**Log call** (set the next follow-up) → **Change Stage** → **Schedule Meeting**
→ Won. Then sign in as the admin and watch the dashboard move.

**Try the test lead source:**

```bash
node -e "
const c=require('crypto');
const body=JSON.stringify({org_id:'<ORG_UUID>',leads:[{id:'demo-1',first_name:'Riya',phone:'98765 43210',source:'Facebook Ad',campaign:'Study Abroad'}]});
const sig='sha256='+c.createHmac('sha256','dev-mock-webhook-secret').update(body).digest('hex');
fetch('http://localhost:3000/api/webhooks/mock-lead',{method:'POST',headers:{'content-type':'application/json','x-mock-signature':sig},body}).then(r=>r.json()).then(console.log)"
```

Run it twice: the second answer is `duplicate`. (`<ORG_UUID>` is the row in
`organizations` for `summit-sales-group`; see Studio at http://127.0.0.1:54333.)

## Commands

| | |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run lint` · `npm run typecheck` | ESLint (includes the layering rules) · `tsc --noEmit` |
| `npm test` | **Unit** tests (Vitest) — pure domain logic, adapters against stubbed HTTP. No database. |
| `npm run test:integration` | **Integration** tests (Vitest) — real users against the local database: tenant isolation, roles, capture/idempotency, webhooks, WhatsApp, meetings, dashboards. Needs `db:start` + `db:reset`. |
| `npm run test:e2e` | **Playwright** — the UI happy path, Today/dashboards, auth (incl. a real password-reset email), WhatsApp demo mode, onboarding, Meta ingestion. |
| `npm run db:start` / `db:stop` / `db:reset` / `db:status` | Local Supabase |
| `npm run db:types` | Regenerate `src/lib/types/database.types.ts` after a migration |

Quality gate before a change is done: `lint`, `typecheck`, `test`,
`test:integration`, `test:e2e`, `build`.

The e2e specs read the seeded demo data, and the integration suite edits it (it
clears a rep's backlog to test the Today queue). Run `npm run db:reset` between
the two — otherwise a few seed-dependent e2e specs fail.

## Migrations and seed

`supabase/migrations/*.sql` are the only way schema changes. `npm run db:reset`
rebuilds the local database from scratch and runs `supabase/seed.sql`
(reproducible; the org id is random per reset, tests look it up by slug
`summit-sales-group`).

| Migration | Adds |
|---|---|
| 0001–0003 | Core schema, helper functions/triggers, RLS policies |
| 0004 | Meta Ads integration |
| 0005 | WhatsApp integration (outbound) |
| 0006 | Org onboarding (one org per user, `is_active`) |
| 0007 | **V1 domain model**: contacts, pipelines, opportunity fields, call logs, lead inquiries (capture idempotency), audit events, integration health, webhook receipts, rate limits, org-consistency constraints, assignment guard |
| 0008 | Reporting aggregates (SQL functions; run with the caller's RLS) |
| 0009 | WhatsApp conversations, inbound messages, delivery status, consent |
| 0010 | Calendar: Google connection, meeting provider/event/attendees |

## Environment variables

Everything is in [`.env.example`](.env.example) with placeholders. The ones that
matter:

| Variable | Needed for |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Always |
| `NEXT_PUBLIC_APP_URL` | OAuth redirect URIs, webhook URLs, reset links |
| `INTEGRATION_ENCRYPTION_KEY` | **Production** — encrypts stored provider tokens |
| `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` | Live Meta Ads + WhatsApp |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `CRON_SECRET` | Live Instagram DMs (+ daily token renewal) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Live Google Calendar / Meet |
| `ENABLE_MOCK_PROVIDERS`, `MOCK_WEBHOOK_SECRET` | Demo mode (default: on outside production) |
| `SIGNUP_ENABLED` | Set `false` to close public sign-up |

**Never** commit `.env.local`. The service-role key bypasses RLS — server only.

## Going live with real integrations

1. **Meta Ads** — create a Meta app, set the three `META_*` vars, add the webhook
   URL `<APP_URL>/api/webhooks/meta` (field `leadgen`), then *Settings →
   Integrations → Meta Ads → Connect*.
2. **WhatsApp** — same Meta app; add the WhatsApp product; webhook URL
   `<APP_URL>/api/webhooks/whatsapp` (field `messages`); connect in Settings, pick
   the number, sync templates. Templates are authored/approved in Meta Business
   Manager.
3. **Instagram DMs** — in the same Meta app add the Instagram product ("API
   setup with Instagram login"); set `INSTAGRAM_APP_ID`/`INSTAGRAM_APP_SECRET`
   (its own, not the Meta ones) and `CRON_SECRET`; redirect URI
   `<APP_URL>/api/integrations/instagram/callback`; webhook
   `<APP_URL>/api/webhooks/instagram` (fields `messages`, `messaging_seen`).
   On the Instagram account turn on *Allow access to messages*, then connect in
   Settings. In Dev mode only accounts added as Instagram testers can connect.
4. **Google Calendar** — Google Cloud OAuth client (Web), Calendar API enabled,
   redirect URI `<APP_URL>/api/integrations/google/callback`, set the two
   `GOOGLE_*` vars, then connect in Settings.

Details, and how to add another provider: [`docs/integrations.md`](docs/integrations.md).

## CI

`.github/workflows/ci.yml` runs the full quality gate above — lint, typecheck,
unit, integration (against a real local Supabase started in the runner), e2e,
build — on every push and pull request against `main`. It doesn't deploy;
Vercel's own Git integration does that independently (see Deployment below).
Turn on branch protection for `main` requiring this workflow before it
actually blocks a bad merge, rather than just reporting one (docs/DECISIONS.md
D-027).

## Deployment

**Vercel + hosted Supabase** (primary target): create a Supabase project, run the
migrations (`supabase db push`), set the environment variables on Vercel
(including `INTEGRATION_ENCRYPTION_KEY`; leave `ENABLE_MOCK_PROVIDERS` unset),
and deploy. Serverless timeouts are why the Meta backfill is resumable. Every
push to `main` auto-deploys via Vercel's Git integration.

**Docker** (anywhere Node runs):

```bash
docker build -t crm-tool \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=... \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
  --build-arg NEXT_PUBLIC_APP_URL=https://crm.example.com .
docker run -p 3000:3000 --env-file .env.production crm-tool
```

Run it from the repo root and keep the trailing `.` (the build context). The `\`
line continuations are bash; in PowerShell put it on one line or continue with a
backtick (`` ` ``), otherwise Docker reports `requires 1 argument`.

`NEXT_PUBLIC_*` are build args (inlined into the browser bundle); every secret is
a runtime variable. The image runs as a non-root user and exposes
`GET /api/health` for healthchecks.

## Documentation

| | |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The as-built mental model (request lifecycle, RLS vs admin client, schema by migration, conventions) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Modules and dependency rules |
| [`docs/domain-model.md`](docs/domain-model.md) | Entities and relationships |
| [`docs/integrations.md`](docs/integrations.md) | Ports, adapters, webhook + idempotency strategy, adding a provider |
| [`docs/security.md`](docs/security.md) | Tenant isolation, authorization, secrets, webhooks, known risks |
| [`docs/v1-scope.md`](docs/v1-scope.md) | What V1 includes and explicitly excludes |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Why things are the way they are |
| [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md), [`docs/V1_GAP_ANALYSIS.md`](docs/V1_GAP_ANALYSIS.md) | The Phase 0 audit and the gap it drove |

Versioning: `v1.x` Core Sales Execution · `v2.x` Automation and Operational
Control · `v3.x` Vertical Sales OS · `v4.x` SaaS Platform and Ecosystem.
