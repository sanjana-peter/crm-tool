import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InstagramConnectionCard } from "@/components/crm/integrations/instagram-connection-card";
import { SimulateInstagramDmCard } from "@/components/crm/integrations/simulate-instagram-dm-card";
import { requireRole } from "@/lib/auth/session";
import { instagramMode } from "@/lib/composition/instagram";
import { getInstagramConfig, getInstagramOAuthRedirectUri, getInstagramWebhookUrl } from "@/lib/integrations/instagram/config";
import { formatDate } from "@/lib/format";
import { getInstagramConnection } from "@/lib/services/instagram";
import { getOrgTimezone } from "@/lib/services/settings";
import { createClient } from "@/lib/supabase/server";

const ERROR_MESSAGES: Record<string, string> = {
  not_configured: "This deployment is missing INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET or a webhook verify token.",
  denied: "The Instagram authorization was cancelled.",
  missing_code: "Instagram did not return an authorization code. Try connecting again.",
  invalid_state: "That authorization link expired. Start the connection again.",
  state_mismatch: "The authorization was started by a different account. Try again.",
  already_connected: "That Instagram account can't be connected here.",
  subscribe_failed:
    "Connected, but Instagram refused the message subscription. Check that the account is a Business or Creator account with “Allow access to messages” on, then reconnect.",
  exchange_failed: "Instagram rejected the login.",
};

export default async function InstagramIntegrationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const session = await requireRole(["admin"]);
  const supabase = await createClient();
  const config = getInstagramConfig();

  const [connection, mode, timezone] = await Promise.all([
    getInstagramConnection(supabase, session.orgId),
    instagramMode(supabase, session.orgId),
    getOrgTimezone(supabase, session.orgId),
  ]);

  const errorMessage = params.error
    ? (ERROR_MESSAGES[params.error] ?? "Connecting Instagram failed.") + (params.detail ? ` (${params.detail})` : "")
    : null;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/settings" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Settings
        </Link>
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          Instagram DMs
          {mode === "demo" && <Badge variant="outline">Demo mode</Badge>}
        </h1>
        <p className="text-sm text-muted-foreground">
          Every new person who DMs your Instagram account becomes a lead. Replies go out from the lead&apos;s page within
          Instagram&apos;s 24-hour window.
        </p>
      </div>

      {errorMessage && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}
      {params.connected === "1" && !params.error && (
        <Alert>
          <AlertDescription>Instagram connected. New DMs will appear as leads.</AlertDescription>
        </Alert>
      )}

      {config ? (
        <InstagramConnectionCard
          connection={
            connection
              ? {
                  username: connection.username,
                  name: connection.name,
                  connectedAt: formatDate(connection.connected_at, timezone),
                  tokenExpiresAt: connection.token_expires_at ? formatDate(connection.token_expires_at, timezone) : null,
                  webhookSubscribed: connection.webhook_subscribed,
                }
              : null
          }
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Not configured</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              This deployment has no Instagram app credentials, so the connection flow is unavailable. In the Meta app,
              add the Instagram product (&ldquo;API setup with Instagram login&rdquo;), then set these environment
              variables and redeploy:
            </p>
            <ul className="list-inside list-disc font-mono text-xs">
              <li>INSTAGRAM_APP_ID</li>
              <li>INSTAGRAM_APP_SECRET</li>
              <li>META_WEBHOOK_VERIFY_TOKEN (or INSTAGRAM_WEBHOOK_VERIFY_TOKEN)</li>
              <li>CRON_SECRET (keeps the access token renewed)</li>
            </ul>
          </CardContent>
        </Card>
      )}

      {config && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Meta app setup</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>In the Meta App Dashboard → Instagram → API setup with Instagram login:</p>
            <ul className="list-inside list-disc space-y-1">
              <li>
                OAuth redirect URI: <code className="font-mono text-xs text-foreground">{getInstagramOAuthRedirectUri(config)}</code>
              </li>
              <li>
                Webhook callback URL: <code className="font-mono text-xs text-foreground">{getInstagramWebhookUrl(config)}</code>,
                subscribed to <code className="font-mono text-xs">messages</code> and{" "}
                <code className="font-mono text-xs">messaging_seen</code>
              </li>
              <li>
                On the Instagram account: Settings → Messages and story replies → Message controls → Connected tools →
                turn on <span className="text-foreground">Allow access to messages</span>.
              </li>
            </ul>
          </CardContent>
        </Card>
      )}

      {mode === "demo" && <SimulateInstagramDmCard />}
    </div>
  );
}
