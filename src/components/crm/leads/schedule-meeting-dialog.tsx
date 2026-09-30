"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { createMeetingAction } from "@/app/(app)/actions";

/**
 * Schedule a meeting from a lead. With a calendar connected (or in demo mode)
 * the default is to create the calendar event and a Meet link and invite the
 * lead; unticking that falls back to the older flow of pasting a link. Times
 * are in the organization's timezone.
 */
export function ScheduleMeetingDialog({
  leadId,
  calendarMode,
  defaultDate,
  contactEmail,
  timezone,
  calendlyBookingUrl,
  trigger,
}: {
  leadId: string;
  calendarMode: "live" | "demo" | "unavailable";
  /** Today in the org's timezone (`YYYY-MM-DD`). */
  defaultDate: string;
  contactEmail: string | null;
  timezone: string;
  calendlyBookingUrl: string | null;
  trigger: React.ReactElement;
}) {
  const hasCalendar = calendarMode !== "unavailable";
  const [open, setOpen] = useState(false);
  const [useCalendar, setUseCalendar] = useState(hasCalendar);
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState("15:00");
  const [duration, setDuration] = useState("30");
  const [guests, setGuests] = useState("");
  const [meetingUrl, setMeetingUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const result = await createMeetingAction({
      lead_id: leadId,
      scheduled_date: date,
      scheduled_time: time,
      duration_minutes: Number(duration),
      use_calendar: useCalendar,
      guest_emails: guests,
      meeting_url: useCalendar ? "" : meetingUrl,
      external_booking_url: !useCalendar && calendlyBookingUrl ? calendlyBookingUrl : "",
      notes,
    });
    setPending(false);

    if (!result.ok) {
      toast.error(result.error);
      return;
    }

    const sync = result.data?.calendar;
    if (sync?.status === "synced") {
      toast.success(sync.demo ? "Meeting recorded (demo mode — no invitation sent)" : "Meeting scheduled and invitations sent");
    } else if (sync?.status === "failed") {
      // Saved, but the calendar event doesn't exist: say so plainly.
      toast.warning(`Meeting saved, but it isn't on the calendar yet: ${sync.error}`);
    } else if (sync?.status === "unavailable") {
      toast.warning("Meeting saved, but no calendar is connected, so no invitation was sent. Connect your Google Calendar in Settings.");
    } else {
      toast.success("Meeting logged");
    }

    setOpen(false);
    setGuests("");
    setNotes("");
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule a meeting</DialogTitle>
          <DialogDescription>
            Times are in {timezone.replace(/_/g, " ")}.
            {calendarMode === "demo" && " Demo mode: nothing is sent to a real calendar."}
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="scheduled_date">Date</Label>
              <Input id="scheduled_date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="scheduled_time">Time</Label>
              <Input id="scheduled_time" type="time" required value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="duration_minutes">Duration (minutes)</Label>
            <Input
              id="duration_minutes"
              type="number"
              min={5}
              max={480}
              step={5}
              required
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </div>

          {hasCalendar && (
            <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={useCalendar}
                onChange={(e) => setUseCalendar(e.target.checked)}
              />
              <span>
                <span className="font-medium">Add to Google Calendar with a Meet link</span>
                <span className="block text-muted-foreground">
                  {contactEmail
                    ? `Invites you and ${contactEmail}.`
                    : "This lead has no email on file, so only you (and any guests below) will be invited."}
                </span>
              </span>
            </label>
          )}

          {useCalendar ? (
            <div className="space-y-1.5">
              <Label htmlFor="guest_emails">Extra guests (optional)</Label>
              <Input
                id="guest_emails"
                placeholder="colleague@company.com, another@company.com"
                value={guests}
                onChange={(e) => setGuests(e.target.value)}
              />
            </div>
          ) : (
            <>
              {calendlyBookingUrl && (
                <>
                  <a
                    href={calendlyBookingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(buttonVariants({ variant: "outline" }), "w-full")}
                  >
                    <ExternalLink />
                    Open Calendly booking page
                  </a>
                  <Separator />
                </>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="meeting_url">Meeting / video link</Label>
                <Input
                  id="meeting_url"
                  type="url"
                  placeholder="https://meet.google.com/…"
                  value={meetingUrl}
                  onChange={(e) => setMeetingUrl(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {hasCalendar ? "" : "No calendar is connected — paste a link, or ask an admin to connect Google Calendar in Settings."}
                </p>
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="meeting_notes">Notes</Label>
            <Textarea id="meeting_notes" rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Saving…" : useCalendar ? "Schedule meeting" : "Log meeting"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
