import Link from "next/link";
import { ArrowLeft, CheckCircle2, CircleSlash, FlaskConical, TriangleAlert, UploadCloud } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireRole } from "@/lib/auth/session";
import { calendarMode } from "@/lib/composition/calendar";
import { instagramMode } from "@/lib/composition/instagram";
import { whatsappMode } from "@/lib/composition/whatsapp";
import { formatShortDateTime } from "@/lib/format";
import { listAuditEvents } from "@/lib/services/audit";
import { getCalendarConnection } from "@/lib/services/calendar-connections";
import { getInstagramConnection } from "@/lib/services/instagram";
import { listIntegrationHealth, type IntegrationHealthRow } from "@/lib/services/integration-health";
import { getConnection as getMetaConnection } from "@/lib/services/meta";
import { getOrgTimezone } from "@/lib/services/settings";
import { listReceipts } from "@/lib/services/webhooks";
import { getConnection as getWhatsAppConnection } from "@/lib/services/whatsapp";
import { createClient } from "@/lib/supabase/server";

type State = "connected" | "failing" | "disconnected" | "demo" | "available";

const STATE_UI: Record<State, { label: string; icon: typeof CheckCircle2; className: string }> = {
  connected: { label: "Connected", icon: CheckCircle2, className: "text-emerald-700 dark:text-emerald-400" },
  failing: { label: "Failing", icon: TriangleAlert, className: "text-red-700 dark:text-red-400" },
  disconnected: { label: "Not connected", icon: CircleSlash, className: "text-muted-foreground" },
  demo: { label: "Demo mode", icon: FlaskConical, className: "text-sky-700 dark:text-sky-400" },
  // Not a connection to be up or down — always ready to use.
  available: { label: "Available", icon: UploadCloud, className: "text-muted-foreground" },
};

interface Row {
  key: string;
  name: string;
  description: string;
  href: string;
  state: State;
  health?: IntegrationHealthRow;
  note?: string;
}

/** A recorded health row wins (it reflects real traffic); otherwise fall back to whether a connection exists. */
function stateOf(connected: boolean, health: IntegrationHealthRow | undefined, demo: boolean): State {
  if (health?.status === "failing") return "failing";
  if (connected) return "connected";
  if (demo) return "demo";
  return "disconnected";
}

export default async function IntegrationHealthPage() {
  const session = await requireRole(["admin"]);
  const supabase = await createClient();

  const [health, meta, whatsapp, instagram, calendar, waMode, igMode, calMode, timezone, receipts, audit] = await Promise.all([
    listIntegrationHealth(supabase, session.orgId),
    getMetaConnection(supabase, session.orgId),
    getWhatsAppConnection(supabase, session.orgId),
    getInstagramConnection(supabase, session.orgId),
    getCalendarConnection(supabase, session.orgId),
    whatsappMode(supabase, session.orgId),
    instagramMode(supabase, session.orgId),
    calendarMode(supabase, session.orgId),
    getOrgTimezone(supabase, session.orgId),
    listReceipts(supabase, session.orgId, 10),
    listAuditEvents(supabase, session.orgId, 15),
  ]);

  const byProvider = new Map(health.map((h) => [h.provider, h]));

  const rows: Row[] = [
    {
      key: "meta",
      name: "Meta Ads (lead capture)",
      description: "Facebook and Instagram lead ads flow into the CRM as they're submitted.",
      href: "/settings/integrations/meta",
      state: stateOf(Boolean(meta), byProvider.get("meta"), false),
      health: byProvider.get("meta"),
    },
    {
      key: "whatsapp",
      name: "WhatsApp (shared business number)",
      description: "Send and receive WhatsApp messages from a lead's page.",
      href: "/settings/integrations/whatsapp",
      state: stateOf(Boolean(whatsapp?.phone_number_id), byProvider.get("whatsapp"), waMode === "demo"),
      health: byProvider.get("whatsapp"),
      note: waMode === "demo" && !whatsapp?.phone_number_id ? "Demo mode: messages are recorded but not delivered." : undefined,
    },
    {
      key: "instagram",
      name: "Instagram DMs",
      description: "DMs to your Instagram account become leads; reply from a lead's page.",
      href: "/settings/integrations/instagram",
      state: stateOf(Boolean(instagram), byProvider.get("instagram"), igMode === "demo"),
      health: byProvider.get("instagram"),
      note: igMode === "demo" && !instagram ? "Demo mode: replies are recorded but not delivered." : undefined,
    },
    {
      key: "google_calendar",
      name: "Google Calendar & Meet",
      description: "Schedule meetings with a Meet link and calendar invitations.",
      href: "/settings/integrations/google",
      state: stateOf(Boolean(calendar), byProvider.get("google_calendar"), calMode === "demo"),
      health: byProvider.get("google_calendar"),
      note: calMode === "demo" && !calendar ? "Demo mode: no real calendar events or invitations are created." : undefined,
    },
  ];

  const mockLead = byProvider.get("mock_lead_source");
  if (mockLead) {
    rows.push({
      key: "mock_lead_source",
      name: "Test lead source",
      description: "The credential-free demo webhook (POST /api/webhooks/mock-lead).",
      href: "/settings/integrations",
      state: stateOf(true, mockLead, false),
      health: mockLead,
    });
  }

  const fileUpload = byProvider.get("file_upload");
  rows.push({
    key: "file_upload",
    name: "File upload",
    description: "Bulk-import leads from a CSV file — a one-off, not a live connection.",
    href: "/settings/integrations/file-upload",
    state: fileUpload?.status === "failing" ? "failing" : "available",
    health: fileUpload,
  });

  return (
    <div className="space-y-6">
      <div>
        <Link href="/settings" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Settings
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">Integrations &amp; health</h1>
        <p className="text-sm text-muted-foreground">Which connections are working, and what went wrong when one isn&apos;t.</p>
      </div>

      <div className="space-y-3">
        {rows.map((row) => {
          const ui = STATE_UI[row.state];
          const Icon = ui.icon;
          return (
            <Card key={row.key} className={row.state === "failing" ? "border-red-600/40" : undefined}>
              <CardContent className="flex flex-wrap items-start justify-between gap-4 p-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={row.href} className="text-sm font-medium hover:underline">
                      {row.name}
                    </Link>
                    <span className={`flex items-center gap-1 text-sm ${ui.className}`}>
                      <Icon className="size-4" aria-hidden />
                      {ui.label}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">{row.description}</p>
                  {row.note && <p className="text-sm text-sky-700 dark:text-sky-400">{row.note}</p>}
                  {row.health?.last_success_at && (
                    <p className="text-xs text-muted-foreground">Last success {formatShortDateTime(row.health.last_success_at, timezone)}</p>
                  )}
                  {row.health?.status === "failing" && row.health.last_error && (
                    <p className="text-sm text-red-700 dark:text-red-400" role="alert">
                      {formatShortDateTime(row.health.last_error_at ?? row.health.updated_at, timezone)} — {row.health.last_error}
                    </p>
                  )}
                </div>
                <Link href={row.href} className="text-sm text-primary hover:underline">
                  Manage
                </Link>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent webhook deliveries</CardTitle>
        </CardHeader>
        <CardContent>
          {receipts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing received yet. Deliveries from WhatsApp, Instagram and other providers appear here.</p>
          ) : (
            <ul className="space-y-2">
              {receipts.map((r) => (
                <li key={r.id as string} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2">
                    <Badge variant={r.status === "failed" ? "destructive" : "secondary"}>{r.status as string}</Badge>
                    <span className="text-muted-foreground">{r.provider as string}</span>
                    {r.error ? <span className="text-red-700 dark:text-red-400">{r.error as string}</span> : null}
                  </span>
                  <span className="text-xs text-muted-foreground">{formatShortDateTime(r.received_at as string, timezone)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Audit log</CardTitle>
        </CardHeader>
        <CardContent>
          {audit.length === 0 ? (
            <p className="text-sm text-muted-foreground">Changes to team, settings and integrations are recorded here.</p>
          ) : (
            <ul className="space-y-2">
              {audit.map((event) => {
                const actor = Array.isArray(event.actor) ? event.actor[0] : event.actor;
                return (
                  <li key={event.id as string} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                    <span>
                      {event.summary as string}
                      <span className="text-muted-foreground"> · {actor?.full_name || actor?.email || "system"}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">{formatShortDateTime(event.created_at as string, timezone)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
