# V1 scope

What v1.x includes and explicitly excludes. Only V1 is implemented; V2–V4 are
architectural context, honoured through extension points, not built.

## Included

**Accounts** — sign-in/out/session, organization creation, memberships with roles
(Owner/Admin, Manager, Salesperson), invitations with a role, role changes,
deactivation, password reset, audit log.

**Contacts** — names, primary + additional phone, email, source, tags, notes,
WhatsApp consent; search by name/phone/email; dedupe by normalized phone/email.

**Pipeline & opportunities** — pipeline with ordered stages; opportunity with
contact, stage, assignee, source, status, value, priority, next action, lost
reason; list and Kanban; every stage move is a timeline event; V1 default stages.

**Lead capture** — manual, Meta Lead Ads (webhook + historical backfill +
attribution), and a credential-free test source; one `captureLead` service;
idempotent.

**Assignment** — manual, with an `AssignmentStrategy` seam; a claimable
unassigned pool for salespeople.

**Timeline** — one chronological, append-only timeline per opportunity/contact.

**Calls (manual)** — `tel:` link + outcome, duration, notes, next follow-up.

**Follow-ups/tasks** — assignee, type, due (org timezone), today / upcoming /
overdue / completed views.

**WhatsApp** — shared business number (Cloud API): templates, free text within
the 24h window, inbound messages, delivery status, opt-out, error surfacing,
consent metadata; mock adapter.

**Meetings** — Google Calendar + Meet via `CalendarProvider`; reschedule/cancel;
sync-failure visibility and retry; Calendly link-out fallback; mock adapter.

**Dashboards** — salesperson *Today*; owner/manager "needs attention", pipeline
counts, meetings, per-rep activity, lead sources.

**Search & filters** — assignee, stage, status, source, campaign, priority,
created date, overdue/due, uncontacted.

**Integration health** — connected / failing / disconnected / demo with last safe
error; recent webhook deliveries.

**Platform** — multi-tenant isolation at the database, Postgres-backed rate
limiting, encrypted credentials, structured redacted logging, Dockerfile,
`/api/health`, reproducible migrations and seed.

## Explicitly excluded (do not build in V1)

Website/funnel builder · email marketing · social scheduler · course/community ·
reputation management · native telephony / SIP / virtual numbers · **call
recording, transcription, voice AI** · general AI agents · visual workflow
builder · complex automation/routing engine · payments/accounting · white-label /
reseller · marketplace · advanced forecasting/BI · native mobile apps.

## Deferred to later versions (extension points exist)

| Item | Version | Where it plugs in |
|---|---|---|
| Round-robin assignment | **done (v2)** | `roundRobinAssignment` + `next_rotation_assignee` (D-028) |
| Load-based assignment | v2 | new `AssignmentStrategy` (`domain/assignment.ts`) |
| Automation (e.g. auto-nudge an unclaimed Meta lead) | v2 | consume timeline events / `JobQueue` (D-008) |
| Ad-spend / ROI | v2 | new adapter + table beside `meta_lead_attribution` |
| Auto-create a lead from an inbound WhatsApp (click-to-WhatsApp ads) | v2 | `handleInbound` "unmatched" branch → `captureLead` |
| Instagram DMs (own account, DM → lead, replies) | **done (v2)** | `services/instagram-conversations.ts` (D-030) |
| Instagram replies after 24 h (`HUMAN_AGENT` tag) | v2 | `sendInstagramText` window check + App Review |
| Per-salesperson calendars | **done (v2)** | personal `calendar_connections` rows (D-029) |
| DaySchedule / Calendly API | v2 | new `CalendarProvider` |
| Multiple pipelines per org | v2 | `pipelines` table exists; needs UI |
| Custom fields, vertical templates | v3 | — |
| Public API, plugin ecosystem, reseller mode | v4 | — |

## Known limitations of V1

- One WhatsApp number **per organization** (shared business number).
- Google Calendar: one shared connection per organization plus an optional
  personal one per member; a meeting goes on its host's own calendar if they
  connected one, else the shared one.
- Inbound WhatsApp from an unknown number is logged as *unmatched*, not turned
  into a lead.
- Kanban drag-and-drop is mouse-only (the Change Stage dialog is the accessible
  path).
- No CSP header yet; no MFA (see `docs/security.md`).
- Meta long-lived tokens are not proactively refreshed.
