"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { sendInstagramReplyAction } from "@/app/(app)/actions";

const MAX_LENGTH = 1000;

/**
 * Reply box for the lead's Instagram thread. Instagram allows replies only
 * within 24 hours of the customer's last message and has no templates, so
 * outside the window there is nothing to send — the box says so instead.
 */
export function InstagramReplyForm({
  leadId,
  windowOpen,
  windowClosesAt,
  optedOut,
  demo,
}: {
  leadId: string;
  windowOpen: boolean;
  /** Pre-formatted in the org's timezone. */
  windowClosesAt: string | null;
  optedOut: boolean;
  demo: boolean;
}) {
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const router = useRouter();

  if (optedOut) {
    return (
      <p className="text-sm text-muted-foreground">
        This contact asked not to be messaged (they replied STOP), so replies are turned off.
      </p>
    );
  }
  if (!windowOpen) {
    return (
      <p className="text-sm text-muted-foreground">
        The 24-hour reply window is closed. Instagram only allows a reply after they message you again — call them or
        use another channel in the meantime.
      </p>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const result = await sendInstagramReplyAction(leadId, body);
    setPending(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    if (result.data?.status === "failed") {
      toast.error(`Not delivered: ${result.data.error}`);
    } else {
      toast.success(demo ? "Reply recorded (demo mode — not delivered)" : "Reply sent");
      setBody("");
    }
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <Label htmlFor="ig-reply" className="sr-only">
        Reply on Instagram
      </Label>
      <Textarea
        id="ig-reply"
        rows={3}
        maxLength={MAX_LENGTH}
        placeholder="Reply on Instagram…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {windowClosesAt ? `Reply window closes ${windowClosesAt}` : null}
        </span>
        <Button type="submit" size="sm" disabled={pending || body.trim() === ""}>
          {pending ? "Sending…" : "Send reply"}
        </Button>
      </div>
    </form>
  );
}
