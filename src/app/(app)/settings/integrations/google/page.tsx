import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireRole } from "@/lib/auth/session";
import { formatDate } from "@/lib/format";
import { getGoogleConfig } from "@/lib/integrations/google/config";
import { calendarMode } from "@/lib/composition/calendar";
import { getCalendarConnection, listPersonalCalendarConnections } from "@/lib/services/calendar-connections";
import { listOrgMembers } from "@/lib/services/team";
import type { Profile } from "@/lib/types/domain";
import { createClient } from "@/lib/supabase/server";
import { GoogleConnectionCard } from "@/components/crm/integrations/google-connection-card";
import { GOOGLE_OAUTH_ERRORS } from "@/components/crm/integrations/google-oauth-messages";

export default async function GoogleIntegrationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const session = await requireRole(["admin"]);
  const supabase = await createClient();
  const config = getGoogleConfig();

  const [connection, mode, organization, personal, members] = await Promise.all([
    getCalendarConnection(supabase, session.orgId),
    calendarMode(supabase, session.orgId),
    supabase.from("organizations").select("timezone").eq("id", session.orgId).single(),
    listPersonalCalendarConnections(supabase, session.orgId),
    listOrgMembers(supabase, session),
  ]);
  const timezone = (organization.data?.timezone as string | undefined) ?? "Asia/Kolkata";

  const errorMessage = params.error ? (GOOGLE_OAUTH_ERRORS[params.error] ?? "Connecting Google Calendar failed.") : null;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/settings" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Settings
        </Link>
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          Google Calendar & Meet
          {mode === "demo" && <Badge variant="outline">Demo mode</Badge>}
        </h1>
        <p className="text-sm text-muted-foreground">
          Schedule meetings from a lead&apos;s page and have them appear on your calendar with a Meet link.
        </p>
      </div>

      {errorMessage && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}
      {params.connected === "1" && (
        <Alert>
          <AlertDescription>Google Calendar connected. New meetings can now create calendar events.</AlertDescription>
        </Alert>
      )}
      {mode === "demo" && (
        <Alert>
          <AlertDescription>
            Demo mode is on: meetings are recorded with a placeholder link and <strong>no real calendar invitations are
            sent</strong>. Connect Google below (needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server) to go live.
          </AlertDescription>
        </Alert>
      )}

      {!config ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Not configured on this server</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>Create an OAuth client in Google Cloud Console (Web application) and set:</p>
            <ul className="list-inside list-disc">
              <li>
                <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>
              </li>
              <li>
                Authorized redirect URI: <code>{`${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/api/integrations/google/callback`}</code>
              </li>
              <li>Enable the Google Calendar API for the project.</li>
            </ul>
          </CardContent>
        </Card>
      ) : (
        <>
          <GoogleConnectionCard connection={connection} connectedAt={connection ? formatDate(connection.connected_at, timezone) : null} />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Personal calendars</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <p className="text-muted-foreground">
                Each person can connect their own Google Calendar in Settings; meetings they host then go there instead
                of the shared calendar.
              </p>
              <ul className="divide-y rounded-md border">
                {members
                  .filter((m) => m.is_active !== false)
                  .map((m) => {
                    const profile = (Array.isArray(m.profile) ? m.profile[0] : m.profile) as Profile;
                    const own = personal.get(m.user_id as string);
                    return (
                      <li key={m.id} className="flex items-center justify-between gap-3 px-3 py-2">
                        <span>{profile.full_name || profile.email}</span>
                        {own ? (
                          own.last_error ? (
                            <Badge variant="destructive">Needs reconnecting</Badge>
                          ) : (
                            <Badge variant="secondary">{own.account_email}</Badge>
                          )
                        ) : (
                          <span className="text-muted-foreground">{connection ? "Uses shared calendar" : "No calendar"}</span>
                        )}
                      </li>
                    );
                  })}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
