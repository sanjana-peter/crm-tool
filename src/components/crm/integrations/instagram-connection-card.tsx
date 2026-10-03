"use client";

import { useTransition } from "react";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { disconnectInstagramAction } from "@/app/(app)/settings/integrations/instagram/actions";

export interface InstagramConnectionSummary {
  username: string;
  name: string | null;
  connectedAt: string;
  tokenExpiresAt: string | null;
  webhookSubscribed: boolean;
}

export function InstagramConnectionCard({ connection }: { connection: InstagramConnectionSummary | null }) {
  const [pending, startTransition] = useTransition();

  function handleDisconnect() {
    startTransition(async () => {
      const result = await disconnectInstagramAction();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Instagram disconnected");
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Connection</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {connection ? (
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1 text-sm">
              <p className="font-medium">
                Connected as @{connection.username}
                {connection.name && <span className="font-normal text-muted-foreground"> ({connection.name})</span>}
              </p>
              {connection.webhookSubscribed ? (
                <p className="text-muted-foreground">New DMs to this account arrive in the CRM as they&apos;re sent.</p>
              ) : (
                <p className="text-amber-600 dark:text-amber-500">
                  Instagram didn&apos;t confirm the message subscription, so DMs may not arrive. Reconnect to retry.
                </p>
              )}
              <p className="text-muted-foreground">
                Since {connection.connectedAt}
                {connection.tokenExpiresAt && <> · access renews automatically (current token valid until {connection.tokenExpiresAt})</>}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" nativeButton={false} render={<a href="/api/integrations/instagram/connect" />}>
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
              Log in with your organization&apos;s Instagram professional (Business or Creator) account. Anyone who DMs it
              becomes a lead, assigned like any other new lead, and your team replies from the lead&apos;s page.
            </p>
            <Button nativeButton={false} render={<a href="/api/integrations/instagram/connect" />}>
              Connect Instagram <ExternalLink className="size-3.5" />
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
