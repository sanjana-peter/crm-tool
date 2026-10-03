import type { HeaderReader } from "@/lib/ports/lead-source";
import type { SendFailureCode, SendOutcome } from "@/lib/ports/whatsapp";
import type { InstagramMessageType } from "@/lib/domain/instagram";

/**
 * Port: sending and receiving Instagram Direct Messages. The CRM core talks
 * only to this — it never sees the Instagram Graph API. Adapters: the
 * Instagram API with Instagram Login (`integrations/instagram/graph-adapter.ts`)
 * and a mock for demos and tests.
 */

export type { SendFailureCode, SendOutcome };

/** What an adapter needs to act for one organization's Instagram account. */
export interface InstagramConnection {
  /** The professional account id (`entry[].id` in webhooks). */
  accountId: string;
  /** Secret. Only ever passed straight through to the provider; never logged. */
  accessToken: string;
}

export interface OutboundInstagramText {
  /** The customer's Instagram-scoped id (IGSID). */
  recipientId: string;
  body: string;
}

export interface InstagramProfile {
  name: string | null;
  username: string | null;
}

/** A customer wrote to the business. */
export interface InstagramMessageEvent {
  kind: "message";
  accountId: string;
  providerMessageId: string;
  /** The customer's IGSID. */
  senderId: string;
  messageType: InstagramMessageType;
  text: string | null;
  attachmentUrl: string | null;
  occurredAt: string;
}

/** The business wrote to a customer — from the CRM, or from the Instagram app itself. */
export interface InstagramEchoEvent {
  kind: "echo";
  accountId: string;
  providerMessageId: string;
  /** The customer's IGSID. */
  recipientId: string;
  messageType: InstagramMessageType;
  text: string | null;
  attachmentUrl: string | null;
  occurredAt: string;
}

/** The customer unsent one of their messages. */
export interface InstagramDeletedEvent {
  kind: "deleted";
  accountId: string;
  providerMessageId: string;
  senderId: string;
  occurredAt: string;
}

/** The customer has seen the conversation up to (and including) this message. */
export interface InstagramReadEvent {
  kind: "read";
  accountId: string;
  providerMessageId: string;
  senderId: string;
  occurredAt: string;
}

export type InstagramEvent = InstagramMessageEvent | InstagramEchoEvent | InstagramDeletedEvent | InstagramReadEvent;

export interface InstagramProvider {
  readonly id: string;
  /** True for adapters that pretend — the UI labels these "Demo mode". */
  readonly isMock: boolean;

  sendText(connection: InstagramConnection, message: OutboundInstagramText): Promise<SendOutcome>;
  /** The sender's display name and @username, or null if Instagram won't say. Never throws. */
  getProfile(connection: InstagramConnection, userId: string): Promise<InstagramProfile | null>;

  /** True only if a webhook delivery provably came from the provider. Called with the exact raw body. */
  verifyWebhook(rawBody: string, headers: HeaderReader): boolean;
  /** Extracts messages, echoes, unsends and read receipts. Throws on a malformed body. */
  parseWebhook(rawBody: string): InstagramEvent[];
}

/** The connected account, as Instagram Login reports it. */
export interface InstagramAccountInfo {
  /** The professional account id — what webhooks call `entry[].id`. */
  user_id: string;
  username: string;
  name?: string;
  profile_picture_url?: string;
}

/** The slice of the Instagram API that connection management needs (token upkeep, unsubscribe). */
export interface InstagramAccountApi {
  refreshLongLivedToken(accessToken: string): Promise<{ access_token: string; expires_in?: number }>;
  unsubscribeWebhooks(accessToken: string): Promise<void>;
}
