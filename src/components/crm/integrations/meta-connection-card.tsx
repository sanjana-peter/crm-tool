"use client";

import { useState, useTransition } from "react";
import { format } from "date-fns";
import { Check, Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  disconnectMetaAction,
  setMetaDefaultAssigneeAction,
} from "@/app/(app)/settings/integrations/meta/actions";
import type { MetaConnection } from "@/lib/services/meta";
import type { Profile } from "@/lib/types/domain";

const UNASSIGNED = "__unassigned__";

export function MetaConnectionCard({
  connection,
  members,
  webhookUrl,
  verifyTokenSet,
}: {
  connection: MetaConnection | null;
  members: Profile[];
  webhookUrl: string;
  verifyTokenSet: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);

  function copyWebhookUrl() {
    navigator.clipboard.writeText(webhookUrl).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => toast.error("Couldn't copy — select the URL and copy it manually.")
    );
  }

  function handleDisconnect() {
    startTransition(async () => {
      const result = await disconnectMetaAction();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Meta account disconnected");
    });
  }

  function handleAssigneeChange(value: string | null) {
    startTransition(async () => {
      const result = await setMetaDefaultAssigneeAction(
        !value || value === UNASSIGNED ? null : value
      );
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Default assignee updated");
    });
  }

  const assigneeLabel = (value: string) => {
    if (value === UNASSIGNED) return "No one (use the team setting)";
    const member = members.find((m) => m.id === value);
    return member?.full_name || member?.email || "Select a person";
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Connection</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {connection ? (
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1 text-sm">
              <p className="font-medium">
                Connected as {connection.meta_user_name ?? connection.meta_user_id}
              </p>
              <p className="text-muted-foreground">
                Since {format(new Date(connection.connected_at), "MMM d, yyyy")}
                {connection.token_expires_at && (
                  <> · token expires {format(new Date(connection.token_expires_at), "MMM d, yyyy")}</>
                )}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                nativeButton={false}
                render={<a href="/api/integrations/meta/connect" />}
              >
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
              Connect the Facebook account that administers your ad Pages. You&apos;ll be asked to
              grant access to your Pages and their lead data.
            </p>
            <Button nativeButton={false} render={<a href="/api/integrations/meta/connect" />}>
              Connect Facebook <ExternalLink className="size-3.5" />
            </Button>
          </div>
        )}

        {connection && (
          <div className="max-w-sm space-y-1.5 border-t pt-5">
            <Label htmlFor="meta-default-assignee">Assign inbound leads to</Label>
            <Select
              defaultValue={connection.default_assignee_id ?? UNASSIGNED}
              onValueChange={handleAssigneeChange}
              disabled={pending}
            >
              <SelectTrigger id="meta-default-assignee">
                <SelectValue placeholder="Select a person">{assigneeLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED}>No one (use the team setting)</SelectItem>
                {members.map((member) => (
                  <SelectItem key={member.id} value={member.id}>
                    {member.full_name || member.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Every lead that arrives from Meta goes to this person. Choose &ldquo;No one&rdquo; to follow the
              lead-assignment setting on the Team page (round-robin, or the unassigned pool).
            </p>
          </div>
        )}

        <div className="space-y-1.5 border-t pt-5">
          <Label>Webhook callback URL</Label>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2.5 py-1.5 text-xs">
              {webhookUrl}
            </code>
            <Button variant="outline" size="icon-sm" onClick={copyWebhookUrl} aria-label="Copy webhook URL">
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Paste this into your Meta app under Webhooks → Page, subscribed to the{" "}
            <code className="font-mono">leadgen</code> field.{" "}
            {verifyTokenSet
              ? "Use the value of META_WEBHOOK_VERIFY_TOKEN as the verify token."
              : "Set META_WEBHOOK_VERIFY_TOKEN first."}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
