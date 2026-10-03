import { randomUUID } from "node:crypto";
import { verifyWebhookSignature } from "@/lib/security/signature";
import type {
  InstagramConnection,
  InstagramEvent,
  InstagramProfile,
  InstagramProvider,
  OutboundInstagramText,
  SendOutcome,
} from "@/lib/ports/instagram";
import type { HeaderReader } from "@/lib/ports/lead-source";
import { parseInstagramWebhook } from "./webhook-format";

export const MOCK_INSTAGRAM_SIGNATURE_HEADER = "x-mock-signature";

/** Demo senders are addressed as `mock.<username>`, so their profile needs no lookup table. */
export const MOCK_INSTAGRAM_SENDER_PREFIX = "mock.";

export function mockInstagramSenderId(username: string): string {
  return `${MOCK_INSTAGRAM_SENDER_PREFIX}${username.trim().replace(/^@/, "").toLowerCase()}`;
}

/**
 * Stands in for Instagram when no account is connected (demo mode). Every
 * send "succeeds" with a fake message id — *nothing is delivered* — except
 * for recipients ending in a trigger, so the failure paths can be shown:
 *
 *   …0000  →  "user unavailable"   (a permanent failure)
 *   …9999  →  rate limited          (a retryable failure)
 *
 * Inbound deliveries use the real Instagram payload shape, parsed by the real
 * parser, signed with the mock webhook secret instead of Meta's.
 */
export class MockInstagramProvider implements InstagramProvider {
  readonly id = "mock";
  readonly isMock = true;

  constructor(private readonly webhookSecret: string) {}

  async sendText(_connection: InstagramConnection, message: OutboundInstagramText): Promise<SendOutcome> {
    if (message.recipientId.endsWith("0000")) {
      return { ok: false, code: "invalid_recipient", retryable: false, error: "Demo mode: this Instagram user isn't available." };
    }
    if (message.recipientId.endsWith("9999")) {
      return { ok: false, code: "rate_limited", retryable: true, error: "Demo mode: Instagram is rate limiting us. Try again in a minute." };
    }
    return { ok: true, providerMessageId: `mock.ig.${randomUUID()}` };
  }

  async getProfile(_connection: InstagramConnection, userId: string): Promise<InstagramProfile | null> {
    if (!userId.startsWith(MOCK_INSTAGRAM_SENDER_PREFIX)) return null;
    return { name: null, username: userId.slice(MOCK_INSTAGRAM_SENDER_PREFIX.length) };
  }

  verifyWebhook(rawBody: string, headers: HeaderReader): boolean {
    return verifyWebhookSignature(rawBody, headers.get(MOCK_INSTAGRAM_SIGNATURE_HEADER), this.webhookSecret);
  }

  parseWebhook(rawBody: string): InstagramEvent[] {
    return parseInstagramWebhook(rawBody);
  }
}

/**
 * A DM in Instagram's real webhook shape, for demo mode and tests: "someone
 * wrote to the org's account". Runs through the same parser a live one does.
 */
export function buildMockInstagramDm(params: {
  accountId: string;
  senderId: string;
  text: string;
  messageId?: string;
  timestampMs?: number;
}): string {
  return JSON.stringify({
    object: "instagram",
    entry: [
      {
        id: params.accountId,
        time: params.timestampMs ?? Date.now(),
        messaging: [
          {
            sender: { id: params.senderId },
            recipient: { id: params.accountId },
            timestamp: params.timestampMs ?? Date.now(),
            message: { mid: params.messageId ?? `mock.ig.in.${randomUUID()}`, text: params.text },
          },
        ],
      },
    ],
  });
}
