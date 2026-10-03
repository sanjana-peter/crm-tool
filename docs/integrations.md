# Integrations

Every external system sits behind an interface (a **port**) so the CRM core never
learns which provider it is talking to. Real adapters and mock adapters
implement the same port.

```
services/ ──depend on──▶ ports/  ◀──implemented by── integrations/<provider>/
                            ▲
   composition/ picks real vs. mock per organization (the only place that knows)
```

| Port (`src/lib/ports/`) | Real adapter | Mock adapter | Used by |
|---|---|---|---|
| `lead-source.ts` → `LeadSourceProvider`, `InboundLead` | Meta Lead Ads (`integrations/meta/`) | `integrations/mock/lead-source.ts` | `services/capture.ts` |
| `whatsapp.ts` → `WhatsAppProvider` | WhatsApp Cloud API (`integrations/whatsapp/cloud-adapter.ts`) | `integrations/whatsapp/mock-adapter.ts` | `services/conversations.ts` |
| `calendar.ts` → `CalendarProvider` | Google Calendar + Meet (`integrations/google/calendar-adapter.ts`) | `integrations/google/mock-adapter.ts` | `services/meetings.ts` |

Composition roots: `src/lib/composition/whatsapp.ts`, `calendar.ts`.

## Live vs. demo (DECISIONS D-017)

For each org the composition root chooses:

1. **Live** — the org connected a real account *and* the server has the app's
   credentials → the real adapter.
2. **Demo** — otherwise, if `mockProvidersEnabled()` (on outside production, off
   in production unless `ENABLE_MOCK_PROVIDERS=true`) → the mock, and the UI says
   **Demo mode** wherever it matters.
3. **Unavailable** — otherwise. The feature says so instead of pretending.

A mock never runs silently in production, and its output says it wasn't real
("demo mode — not delivered").

## Adapter contracts

### Lead source

```ts
interface LeadSourceProvider {
  id: string;
  verify(rawBody, headers): boolean;             // signature over the EXACT raw body
  parse(rawBody): LeadSourceEvent[];             // may carry only ids (Meta)
  resolve(event, creds): Promise<InboundLead>;   // fetch the lead if the delivery had only ids
}
```

Everything then goes through **`captureLead(db, actor, input, { onCaptured })`**:

1. Replayed external event? → `duplicate`, write nothing.
2. Find contact by normalized phone/email, else create (unique index resolves races).
3. Contact already has an *open* opportunity? → `merged` (or `existing_restricted`
   if the actor may not see it), logged as "New inquiry".
4. Else create the opportunity in the pipeline's entry stage, assigned by the
   `AssignmentStrategy`: an explicit assignee (a person's choice, or the
   integration's default assignee) wins; otherwise the org's mode — manual
   (unassigned pool) or round-robin (`next_rotation_assignee`, D-028).

`onCaptured` lets an adapter store provider-specific extras (Meta's ad
attribution) without the core knowing they exist; it also runs on `duplicate`, so
a delivery that died half-way is repaired by the provider's retry.

**Four callers share this one door:** manual entry (`services/leads.ts`), the
Meta webhook, the mock source, and an admin's CSV upload
(`services/file-import.ts`, Settings → Integrations → File upload,
DECISIONS D-026). The CSV importer isn't a `LeadSourceProvider` — there's no
ongoing connection to verify or poll, just a one-off admin action — so it calls
`captureLead` directly under the uploading admin's own session, the same way
manual entry does. Its own idempotency is just the identity dedupe already in
step 2: re-uploading the same file merges every row into the opportunities it
already created instead of duplicating them.

### WhatsApp

```ts
interface WhatsAppProvider {
  sendTemplate(conn, msg): Promise<SendOutcome>;   // never throws
  sendText(conn, msg): Promise<SendOutcome>;       // 24-hour window rule enforced by the service
  verifyWebhook(rawBody, headers): boolean;
  parseWebhook(rawBody): WhatsAppEvent[];          // inbound messages + delivery statuses
}
type SendOutcome = { ok: true; providerMessageId } | { ok: false; code; error; retryable };
```

Failure `code` is the CRM's vocabulary (`auth`, `window_closed`,
`invalid_recipient`, `rate_limited`, `other`), not Meta's. Only integration-level
failures (`auth`, `other`) turn the integration "failing"; a bad number does not.

**Mock behaviour:** sends succeed with a fake id, except numbers ending `0000`
(permanent failure) or `9999` (retryable). Inbound deliveries use the real Cloud
API payload shape parsed by the real parser, signed with `MOCK_WEBHOOK_SECRET`; a
`phone_number_id` of `mock:<orgId>` addresses a tenant directly (only honoured for
the mock provider — a real Meta signature cannot use it).

### Instagram DMs

```ts
interface InstagramProvider {
  sendText(conn, { recipientId, body }): Promise<SendOutcome>;  // never throws; 24-hour rule enforced by the service
  getProfile(conn, igsid): Promise<{ name; username } | null>; // never throws
  verifyWebhook(rawBody, headers): boolean;
  parseWebhook(rawBody): InstagramEvent[];   // message | echo | deleted | read
}
```

Instagram API with Instagram Login (`graph.instagram.com`): each org connects its
own professional account; no Facebook Page. Same failure vocabulary as WhatsApp.
A DM from an unknown sender is captured as a lead (`captureLead`, external id =
the sender's IGSID, so concurrent first DMs make one lead). Replies are allowed
only within 24 hours of the customer's last DM — Instagram has no templates.
The webhook signature is accepted against the Instagram app secret or the Meta
app secret (Meta has used both). The long-lived token is renewed daily by
`/api/cron/instagram-token-refresh`.

**Mock behaviour:** sends succeed with a fake id, except recipients ending `0000`
(permanent) or `9999` (retryable). A sender id `mock.<username>` gives the
profile `@username`; an account id of `mock:<orgId>` addresses a tenant directly
(mock provider only). Settings → Integrations → Instagram has a "simulate a DM"
form in demo mode.

### Calendar

```ts
interface CalendarProvider {
  createEvent(conn, event): Promise<CalendarEventOutcome>;   // idempotent on event.eventId
  updateEventTime(conn, externalId, change): Promise<CalendarOperationOutcome>;
  cancelEvent(conn, externalId): Promise<CalendarOperationOutcome>;
}
```

The event id is derived from the meeting id, and Google accepts a client-chosen id
— so a retry after a timeout hits `409 already exists` and fetches the event
instead of double-booking. A meeting is **saved first**; if the calendar call
fails the meeting keeps `sync_error`, the UI shows it, and *Retry* re-runs the
idempotent create.

**Mock behaviour:** fabricates an event and a clearly fake Meet link; an attendee
at `@fail.test` makes it fail (retryable).

## Webhooks and idempotency

| Endpoint | Auth | Idempotency |
|---|---|---|
| `POST /api/webhooks/meta` | `X-Hub-Signature-256` HMAC over the raw body | `lead_inquiries` + unique `(org, provider, external_id)`; every delivery logged in `meta_webhook_events` |
| `GET/POST /api/webhooks/whatsapp` | verify token (GET); Meta HMAC or mock HMAC (POST) | `webhook_receipts` unique `(provider, event_key)`; message id unique per org; status changes are monotonic |
| `GET/POST /api/webhooks/instagram` | verify token (GET); Meta HMAC (Instagram or Meta app secret) or mock HMAC (POST) | `webhook_receipts` unique `(provider, event_key)`; message id unique per org (a CRM send's echo dedupes on it); first DM → `lead_inquiries` keyed on the sender |
| `GET /api/cron/instagram-token-refresh` | `Authorization: Bearer $CRON_SECRET` (Vercel Cron) | refreshes only tokens that are due |
| `POST /api/webhooks/mock-lead` | mock HMAC; **404 unless mocks are enabled** | `webhook_receipts` + `lead_inquiries` |
| `GET /api/health` | public, uninformative | — |

All webhook handlers follow one shape:

`request-id → coarse IP rate limit → verify signature (exact bytes) → parse →
resolve org (provider account id → exactly one tenant) → receipt (unique key) →
service (idempotent) → finish receipt → 200`

- A **replay** finds its receipt and is a no-op. A receipt that `failed` is *not*
  settled — the provider's retry reprocesses it, which is how transient errors
  heal.
- Processing failures still answer **200** (recorded on the receipt), because a
  non-2xx makes Meta disable the subscription after sustained failures.
- Receipts store **no payload**; errors are scrubbed of tokens before being stored.
- Rate limits are Postgres-backed (`rate_limit_hit`), so they hold across
  serverless instances.

## Credentials

Provider tokens are stored in tables that clients cannot read at all (RLS with no
policies, privileges revoked) **and** encrypted with AES-256-GCM
(`INTEGRATION_ENCRYPTION_KEY`, `enc:v1:` prefix). They are decrypted only inside
composition/services running as the service role, passed straight to the
adapter, and never logged (the logger redacts by key name and by value pattern).

## Adding another provider

1. **Port exists?** (lead source / WhatsApp / calendar). If not, add an interface
   in `src/lib/ports/` — only types, importing only `domain`.
2. **Adapter:** new folder `src/lib/integrations/<name>/` with `config.ts`
   (env → typed config or `null`, never throws at import), the adapter class,
   `mapping.ts` (external → domain), `types.ts`. It may import `ports`, `domain`,
   `security`, `observability` — **never** `services`.
3. **Mock:** an adapter for the same port, for demos and tests.
4. **Wire it:** one branch in the matching `src/lib/composition/*.ts` and, for a
   new inbound provider, a route under `src/app/api/webhooks/<name>/route.ts`
   following the shape above.
5. **Health:** `markConnected` / `markFailing` from `services/integration-health.ts`
   so it appears on *Settings → Integrations*.
6. **Credentials:** a locked-down token table (RLS on, no policies, revoke) and
   `encryptSecret`/`decryptSecret`. Add the token-isolation test.
7. **Tests:** adapter against stubbed HTTP (unit), plus an integration test for
   the webhook idempotency.

Example — DaySchedule / Calendly's API: implement `CalendarProvider`, add a
`provider` value to `meetings`' check constraint in a migration, add a branch in
`composition/calendar.ts`. Meetings, the timeline and the UI don't change.
