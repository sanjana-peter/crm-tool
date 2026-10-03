import { formatDateTime } from "@/lib/format";
import {
  UserPlus,
  RefreshCw,
  ArrowRightLeft,
  StickyNote,
  CalendarPlus,
  CalendarCheck,
  CalendarX,
  ListChecks,
  CheckCircle2,
  XCircle,
  Clock,
  Megaphone,
  MessageCircle,
  MessageSquareReply,
  MessageSquareWarning,
  MessagesSquare,
  Send,
  PhoneCall,
  CopyPlus,
  CalendarClock,
  Upload,
} from "lucide-react";
import type { Activity, ActivityType } from "@/lib/types/domain";

const ICONS: Record<ActivityType, React.ComponentType<{ className?: string }>> = {
  lead_created: UserPlus,
  lead_imported_from_ads: Megaphone,
  lead_imported_from_file: Upload,
  lead_updated: RefreshCw,
  lead_inquiry_received: CopyPlus,
  call_logged: PhoneCall,
  whatsapp_sent: MessageCircle,
  whatsapp_received: MessageSquareReply,
  whatsapp_failed: MessageSquareWarning,
  instagram_sent: Send,
  instagram_received: MessagesSquare,
  instagram_failed: MessageSquareWarning,
  lead_assigned: ArrowRightLeft,
  status_changed: RefreshCw,
  note_created: StickyNote,
  meeting_scheduled: CalendarPlus,
  meeting_rescheduled: CalendarClock,
  meeting_completed: CalendarCheck,
  meeting_cancelled: CalendarX,
  followup_created: ListChecks,
  followup_completed: CheckCircle2,
  followup_cancelled: XCircle,
  followup_rescheduled: Clock,
};

export function ActivityTimeline({ activities, timezone }: { activities: Activity[]; timezone: string }) {
  if (activities.length === 0) {
    return <p className="text-sm text-muted-foreground">No activity yet.</p>;
  }

  return (
    <ol className="space-y-0">
      {activities.map((activity, idx) => {
        const Icon = ICONS[activity.activity_type as ActivityType] ?? RefreshCw;
        return (
          <li key={activity.id} className="relative flex gap-3 pb-6 last:pb-0">
            {idx < activities.length - 1 && (
              <span className="absolute left-[15px] top-8 h-[calc(100%-1.5rem)] w-px bg-border" />
            )}
            <span className="z-10 flex size-8 shrink-0 items-center justify-center rounded-full border bg-background">
              <Icon className="size-4 text-muted-foreground" />
            </span>
            <div className="pt-1">
              <p className="text-sm font-medium">{activity.title}</p>
              {activity.description && (
                <p className="text-sm text-muted-foreground">{activity.description}</p>
              )}
              <p className="mt-0.5 text-xs text-muted-foreground">
                {formatDateTime(activity.created_at, timezone)}
                {activity.actor?.full_name ? ` · ${activity.actor.full_name}` : ""}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
