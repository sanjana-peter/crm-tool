"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { simulateInstagramDmAction } from "@/app/(app)/settings/integrations/instagram/actions";

/** Demo mode only: fakes a DM to the org's account through the real inbound pipeline. */
export function SimulateInstagramDmCard() {
  const [username, setUsername] = useState("riya.sharma");
  const [text, setText] = useState("Hi! Saw your post — what are the fees for the weekend batch?");
  const [pending, setPending] = useState(false);
  const [leadId, setLeadId] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const result = await simulateInstagramDmAction(username, text);
    setPending(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setLeadId(result.data?.leadId ?? null);
    toast.success("Simulated DM received");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Try it: simulate a DM</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Demo mode. This goes through the same path a real Instagram webhook uses: a username the CRM hasn&apos;t seen
            becomes a new lead; a known one lands on their existing lead. Try sending &ldquo;STOP&rdquo; afterwards.
          </p>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,14rem)_1fr]">
            <div className="space-y-1.5">
              <Label htmlFor="sim-ig-username">From</Label>
              <Input id="sim-ig-username" value={username} maxLength={31} onChange={(e) => setUsername(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sim-ig-text">Their message</Label>
              <Textarea id="sim-ig-text" rows={2} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending || !username.trim() || !text.trim()}>
              {pending ? "Delivering…" : "Deliver DM"}
            </Button>
            {leadId && (
              <Link href={`/leads/${leadId}`} className="text-sm text-primary hover:underline">
                Open the lead
              </Link>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
