import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { requireSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getOrganization } from "@/lib/services/settings";
import { getConnection as getMetaConnection } from "@/lib/services/meta";
import { getConnection as getWhatsAppConnection } from "@/lib/services/whatsapp";
import { getCalendarConnection, getPersonalCalendarConnection } from "@/lib/services/calendar-connections";
import { getGoogleConfig } from "@/lib/integrations/google/config";
import { formatDate } from "@/lib/format";
import { permissions } from "@/lib/domain/permissions";
import { SettingsForm } from "@/components/crm/settings/settings-form";
import { PersonalCalendarCard } from "@/components/crm/integrations/personal-calendar-card";
import { GOOGLE_OAUTH_ERRORS } from "@/components/crm/integrations/google-oauth-messages";

function IntegrationRow({
  href,
  name,
  description,
  connected,
  label,
}: {
  href: string;
  name: string;
  description: string;
  connected: boolean;
  /** Overrides the Connected / Not connected badge. */
  label?: string;
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <Link href={href} className="flex items-center justify-between gap-4 p-4 hover:bg-muted/50">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{name}</span>
              {label ? (
                <Badge variant="outline">{label}</Badge>
              ) : connected ? (
                <Badge variant="secondary">Connected</Badge>
              ) : (
                <Badge variant="outline">Not connected</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </Link>
      </CardContent>
    </Card>
  );
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const session = await requireSession();
  const supabase = await createClient();
  const isAdmin = permissions.canEditSettings(session.role);

  const [organization, metaConnection, whatsAppConnection, calendarConnection, myCalendar] = await Promise.all([
    getOrganization(supabase, session.orgId),
    isAdmin ? getMetaConnection(supabase, session.orgId) : Promise.resolve(null),
    isAdmin ? getWhatsAppConnection(supabase, session.orgId) : Promise.resolve(null),
    getCalendarConnection(supabase, session.orgId),
    getPersonalCalendarConnection(supabase, session.orgId, session.user.id),
  ]);
  const timezone = (organization.timezone as string | undefined) ?? "Asia/Kolkata";

  // Set by the Google OAuth callback after a personal connection attempt.
  const calendarMessage = params.calendar_error
    ? { kind: "error" as const, text: GOOGLE_OAUTH_ERRORS[params.calendar_error] ?? "Connecting your Google Calendar failed." }
    : params.calendar_connected === "1"
      ? { kind: "success" as const, text: "Your Google Calendar is connected. Meetings you host will be created on it." }
      : null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Organization and integration configuration.</p>
      </div>

      <PersonalCalendarCard
        configured={Boolean(getGoogleConfig())}
        accountEmail={myCalendar?.account_email ?? null}
        connectedAt={myCalendar ? formatDate(myCalendar.connected_at, timezone) : null}
        lastError={myCalendar?.last_error ?? null}
        hasSharedCalendar={Boolean(calendarConnection)}
        message={calendarMessage}
      />

      {isAdmin ? (
        <>
          <SettingsForm
            orgName={organization.name}
            calendlyBookingUrl={organization.calendly_booking_url}
            timezone={timezone}
          />

          <IntegrationRow
            href="/settings/integrations"
            name="Integrations & health"
            description="See whether each connection is working, recent deliveries, and the audit log."
            connected
            label="Overview"
          />

          <IntegrationRow
            href="/settings/integrations/meta"
            name="Meta Ads"
            description="Ingest Facebook and Instagram lead ads straight into the CRM."
            connected={Boolean(metaConnection)}
          />
          <IntegrationRow
            href="/settings/integrations/whatsapp"
            name="WhatsApp"
            description="Send approved WhatsApp templates to leads from their detail page."
            connected={Boolean(whatsAppConnection)}
          />
          <IntegrationRow
            href="/settings/integrations/google"
            name="Google Calendar & Meet"
            description="The team's shared calendar, for hosts who haven't connected their own."
            connected={Boolean(calendarConnection)}
          />
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only admins can change organization settings. Contact your admin to update these.
        </p>
      )}
    </div>
  );
}
