"use client";

import { useTransition } from "react";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { disconnectGoogleCalendarAction } from "@/app/(app)/settings/integrations/google/actions";
import type { CalendarConnectionRow } from "@/lib/services/calendar-connections";

export function GoogleConnectionCard({
  connection,
  connectedAt,
}: {
  connection: CalendarConnectionRow | null;
  /** Pre-formatted in the org's timezone by the server. */
  connectedAt: string | null;
}) {
  const [pending, startTransition] = useTransition();

  function handleDisconnect() {
    startTransition(async () => {
      const result = await disconnectGoogleCalendarAction();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Google Calendar disconnected");
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Shared calendar</CardTitle>
      </CardHeader>
      <CardContent>
        {connection ? (
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1 text-sm">
              <p className="font-medium">Connected as {connection.account_email}</p>
              <p className="text-muted-foreground">
                Meetings hosted by someone who hasn&apos;t connected their own calendar are created here with a Google
                Meet link, and the salesperson and lead are invited.
              </p>
              {connectedAt && <p className="text-muted-foreground">Since {connectedAt}</p>}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" nativeButton={false} render={<a href="/api/integrations/google/connect" />}>
                Reconnect
              </Button>
              <Button variant="outline" onClick={handleDisconnect} disabled={pending}>
                Disconnect
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Connect the Google account whose calendar should hold your team&apos;s sales meetings. Anyone who connects
              their own calendar in Settings uses that instead. The CRM only asks to create and edit events — it
              can&apos;t read the rest of your calendar.
            </p>
            <Button nativeButton={false} render={<a href="/api/integrations/google/connect" />}>
              Connect Google Calendar <ExternalLink className="size-3.5" />
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
