/**
 * Instagram DM business rules that don't depend on any provider's API.
 */

export { isOptOutText, isWithinServiceWindow, serviceWindowClosesAt, checkSendAllowed } from "./whatsapp";
export type { ConsentStatus } from "./whatsapp";

export type InstagramMessageStatus = "sent" | "read" | "failed" | "received" | "deleted";

export const INSTAGRAM_MESSAGE_TYPES = [
  "text",
  "image",
  "video",
  "audio",
  "file",
  "story_reply",
  "story_mention",
  "share",
  "unsupported",
] as const;
export type InstagramMessageType = (typeof INSTAGRAM_MESSAGE_TYPES)[number];

/** Instagram rejects text messages longer than 1000 characters. */
export const INSTAGRAM_MAX_TEXT_LENGTH = 1000;

/** What a salesperson sees for a message that isn't plain text. */
export function describeInstagramMessage(type: InstagramMessageType, text: string | null): string {
  if (text && text.trim()) return type === "story_reply" ? `Replied to your story: ${text}` : text;
  switch (type) {
    case "image":
      return "[Photo]";
    case "video":
      return "[Video]";
    case "audio":
      return "[Voice message]";
    case "file":
      return "[File]";
    case "story_reply":
      return "[Replied to your story]";
    case "story_mention":
      return "[Mentioned you in their story]";
    case "share":
      return "[Shared a post]";
    default:
      return "[Unsupported message]";
  }
}

/**
 * Applies a read receipt or an unsend to a message's current status.
 * Monotonic like WhatsApp's: `deleted` and `failed` are final, and an inbound
 * message has no delivery lifecycle — only an unsend can change it.
 */
export function nextInstagramStatus(
  current: InstagramMessageStatus,
  incoming: "read" | "deleted"
): InstagramMessageStatus {
  if (current === "deleted") return current;
  if (incoming === "deleted") return "deleted";
  if (current === "sent") return "read";
  return current;
}

/** The name a new contact gets when Instagram tells us little about the sender. */
export function instagramContactName(profile: { name?: string | null; username?: string | null } | null): {
  firstName: string;
  lastName: string | null;
} {
  const name = profile?.name?.trim();
  if (name) {
    const [first, ...rest] = name.split(/\s+/);
    return { firstName: first, lastName: rest.length > 0 ? rest.join(" ") : null };
  }
  const username = profile?.username?.trim();
  if (username) return { firstName: `@${username.replace(/^@/, "")}`, lastName: null };
  return { firstName: "Instagram user", lastName: null };
}

const DAY_MS = 86_400_000;

/** Refresh a long-lived token once it's this old — far inside its ~60-day life. */
export const TOKEN_REFRESH_AFTER_DAYS = 7;

/**
 * Whether a long-lived Instagram token should be refreshed now. Instagram only
 * accepts a refresh once the token is at least 24 hours old, and a token that
 * has already expired can't be refreshed at all (the org must reconnect).
 */
export function shouldRefreshToken(
  token: { refreshedAt: string | null; expiresAt: string | null },
  now: Date = new Date()
): boolean {
  const refreshedAt = token.refreshedAt ? new Date(token.refreshedAt).getTime() : NaN;
  const expiresAt = token.expiresAt ? new Date(token.expiresAt).getTime() : NaN;

  if (Number.isFinite(expiresAt) && expiresAt <= now.getTime()) return false;
  if (!Number.isFinite(refreshedAt)) return true;
  if (now.getTime() - refreshedAt < DAY_MS) return false;
  if (now.getTime() - refreshedAt >= TOKEN_REFRESH_AFTER_DAYS * DAY_MS) return true;
  return Number.isFinite(expiresAt) && expiresAt - now.getTime() < 10 * DAY_MS;
}
