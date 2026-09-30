"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { disconnectMyCalendarAction } from "@/app/(app)/settings/integrations/google/actions";

const CONNECT_URL = "/api/integrations/google/connect?scope=personal";

/**
 * A member's own Google Calendar. When connected, meetings they host are
 * created on it (with a Meet link, from their own account) instead of on the
 * org's shared calendar.
 */
export function PersonalCalendarCard({
  configured,
  accountEmail,
  connectedAt,
  lastError,
  hasSharedCalendar,
  message,
}: {
  /** The server has Google OAuth credentials. */
  configured: boolean;
  accountEmail: string | null;
  /** Pre-formatted in the org's timezone by the server. */
  connectedAt: string | null;
  lastError: string | null;
  hasSharedCalendar: boolean;
  message: { kind: "success" | "error"; text: string } | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleDisconnect() {
    startTransition(async () => {
      const result = await disconnectMyCalendarAction();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Your Google Calendar is disconnected");
      router.refresh();
    });
  }

  const fallback = hasSharedCalendar
    ? "Meetings you host go on your team's shared calendar."
    : "Without it, meetings you schedule are saved in the CRM but no calendar invitation is sent.";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          My Google Calendar
          {accountEmail ? (
            lastError ? (
              <Badge variant="destructive">Needs reconnecting</Badge>
            ) : (
              <Badge variant="secondary">Connected</Badge>
            )
          ) : (
            <Badge variant="outline">Not connected</Badge>
          )}
        </CardTitle>
        <CardDescription>
          Meetings you host are created on your own calendar with a Google Meet link, and the lead gets the invitation
          from you.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {message && (
          <Alert variant={message.kind === "error" ? "destructive" : "default"}>
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        )}

        {!configured ? (
          <p className="text-sm text-muted-foreground">
            Google Calendar isn&apos;t set up on this server yet. Ask your admin.
          </p>
        ) : accountEmail ? (
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1 text-sm">
              <p className="font-medium">Connected as {accountEmail}</p>
              {connectedAt && <p className="text-muted-foreground">Since {connectedAt}</p>}
              {lastError && <p className="text-destructive">Last attempt failed: {lastError}</p>}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" nativeButton={false} render={<a href={CONNECT_URL} />}>
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
              {fallback} The CRM only asks to create and edit events — it can&apos;t read the rest of your calendar.
            </p>
            <Button nativeButton={false} render={<a href={CONNECT_URL} />}>
              Connect my Google Calendar <ExternalLink className="size-3.5" />
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
