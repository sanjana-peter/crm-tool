import { AlertCircle, Check, CheckCheck } from "lucide-react";
import { formatShortDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { InstagramMessageRow } from "@/lib/services/instagram-conversations";

const STATUS_LABEL: Record<InstagramMessageRow["status"], string> = {
  sent: "Sent",
  read: "Seen",
  failed: "Failed",
  received: "Received",
  deleted: "Unsent",
};

function StatusMark({ status }: { status: InstagramMessageRow["status"] }) {
  if (status === "failed") return <AlertCircle className="size-3.5 text-destructive" aria-hidden />;
  if (status === "read") return <CheckCheck className="size-3.5 text-sky-600" aria-hidden />;
  if (status === "sent") return <Check className="size-3.5" aria-hidden />;
  return null;
}

/** The contact's Instagram thread, oldest first, customer on the left and the business on the right. */
export function InstagramMessagesList({ messages, timezone }: { messages: InstagramMessageRow[]; timezone: string }) {
  if (messages.length === 0) {
    return <p className="text-sm text-muted-foreground">No Instagram messages with this lead yet.</p>;
  }

  const ordered = [...messages].reverse();

  return (
    <ul className="space-y-3" aria-label="Instagram conversation">
      {ordered.map((m) => {
        const inbound = m.direction === "inbound";
        return (
          <li key={m.id} className={cn("flex", inbound ? "justify-start" : "justify-end")}>
            <div
              className={cn(
                "max-w-[85%] space-y-1 rounded-lg border px-3 py-2",
                inbound ? "bg-muted/50" : "bg-primary/5",
                m.status === "failed" && "border-destructive/50"
              )}
            >
              <p className={cn("whitespace-pre-wrap text-sm", m.status === "deleted" && "italic text-muted-foreground")}>
                {m.body}
              </p>
              {m.attachment_url && m.status !== "deleted" && (
                <a href={m.attachment_url} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
                  View attachment
                </a>
              )}
              {m.error && (
                <p className="text-xs text-destructive" role="alert">
                  Not delivered: {m.error}
                </p>
              )}
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <StatusMark status={m.status} />
                <span>{STATUS_LABEL[m.status]}</span>
                <span>· {formatShortDateTime(m.created_at, timezone)}</span>
                {!inbound && m.sender && <span>· {m.sender.full_name || m.sender.email}</span>}
                {!inbound && m.is_echo && <span>· from the Instagram app</span>}
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
