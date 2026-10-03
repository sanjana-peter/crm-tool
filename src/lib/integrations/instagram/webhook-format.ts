import { z } from "zod";
import type { InstagramMessageType } from "@/lib/domain/instagram";
import type { InstagramEvent } from "@/lib/ports/instagram";

/**
 * Parses the Instagram messaging webhook envelope
 * (`{ object: "instagram", entry[].messaging[] }`). Shared by the real adapter
 * and the mock, so a demo delivery runs the very same parsing a real one does.
 *
 * Lenient about fields we don't use (Meta adds them freely) and strict about
 * the ones we depend on: anything unusable is dropped rather than guessed at.
 */

const attachmentSchema = z.object({
  type: z.string().optional(),
  payload: z.object({ url: z.string().optional() }).passthrough().nullable().optional(),
});

const messageSchema = z.object({
  mid: z.string().min(1),
  text: z.string().optional(),
  is_echo: z.boolean().optional(),
  is_deleted: z.boolean().optional(),
  is_unsupported: z.boolean().optional(),
  attachments: z.array(attachmentSchema).optional(),
  reply_to: z.object({ story: z.unknown().optional() }).passthrough().optional(),
});

const messagingSchema = z.object({
  sender: z.object({ id: z.string().min(1) }),
  recipient: z.object({ id: z.string().min(1) }),
  timestamp: z.union([z.number(), z.string()]).optional(),
  message: z.unknown().optional(),
  read: z.object({ mid: z.string().min(1) }).optional(),
});

const envelopeSchema = z.object({
  object: z.string().optional(),
  entry: z.array(z.object({ id: z.string().min(1), messaging: z.array(z.unknown()).optional() })).optional(),
});

/** Instagram sends milliseconds here (unlike WhatsApp's seconds); accept either. */
function toIso(timestamp: number | string | undefined): string {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return new Date().toISOString();
  return new Date(value < 1e12 ? value * 1000 : value).toISOString();
}

function classify(message: z.infer<typeof messageSchema>): { type: InstagramMessageType; url: string | null } {
  const attachment = message.attachments?.[0];
  const url = attachment?.payload?.url ?? null;

  if (message.reply_to?.story !== undefined) return { type: "story_reply", url };
  if (message.is_unsupported) return { type: "unsupported", url: null };

  switch (attachment?.type) {
    case undefined:
      return { type: message.text !== undefined ? "text" : "unsupported", url: null };
    case "image":
    case "animated_image":
      return { type: "image", url };
    case "video":
    case "ig_reel":
    case "reel":
      return { type: "video", url };
    case "audio":
      return { type: "audio", url };
    case "file":
      return { type: "file", url };
    case "story_mention":
      return { type: "story_mention", url };
    case "share":
    case "ig_post":
      return { type: "share", url };
    default:
      return { type: "unsupported", url };
  }
}

export function parseInstagramWebhook(rawBody: string): InstagramEvent[] {
  const envelope = envelopeSchema.parse(JSON.parse(rawBody));
  if (envelope.object && envelope.object !== "instagram") return [];

  const events: InstagramEvent[] = [];

  for (const entry of envelope.entry ?? []) {
    const accountId = entry.id;

    for (const raw of entry.messaging ?? []) {
      const parsed = messagingSchema.safeParse(raw);
      if (!parsed.success) continue;
      const m = parsed.data;
      const occurredAt = toIso(m.timestamp);

      if (m.read) {
        events.push({ kind: "read", accountId, providerMessageId: m.read.mid, senderId: m.sender.id, occurredAt });
        continue;
      }

      const message = messageSchema.safeParse(m.message);
      if (!message.success) continue;
      const msg = message.data;

      if (msg.is_deleted) {
        events.push({ kind: "deleted", accountId, providerMessageId: msg.mid, senderId: m.sender.id, occurredAt });
        continue;
      }

      const { type, url } = classify(msg);
      const text = msg.text ?? null;

      if (msg.is_echo) {
        events.push({
          kind: "echo",
          accountId,
          providerMessageId: msg.mid,
          recipientId: m.recipient.id,
          messageType: type,
          text,
          attachmentUrl: url,
          occurredAt,
        });
      } else {
        events.push({
          kind: "message",
          accountId,
          providerMessageId: msg.mid,
          senderId: m.sender.id,
          messageType: type,
          text,
          attachmentUrl: url,
          occurredAt,
        });
      }
    }
  }

  return events;
}
