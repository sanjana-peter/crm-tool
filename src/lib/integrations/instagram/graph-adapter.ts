import "server-only";
import { MetaApiError } from "@/lib/integrations/meta/client";
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
import { InstagramGraphClient } from "./client";
import type { InstagramConfig } from "./config";
import { parseInstagramWebhook } from "./webhook-format";

type Failure = Extract<SendOutcome, { ok: false }>;

/** Instagram messaging error codes worth telling apart (Messenger Platform error codes). */
const WINDOW_CLOSED_SUBCODES = new Set([2534022, 2018278]);
const USER_UNAVAILABLE = 551;
const INVALID_RECIPIENT_SUBCODES = new Set([2534014, 2018001, 1545041]);
const RATE_LIMITED_CODES = new Set([4, 17, 32, 613]);

/**
 * Turns anything the Instagram API (or the network) throws into the CRM's
 * small vocabulary of send failures. `error` is safe to show a person — it's
 * Meta's own message, which never contains our credentials.
 */
export function classifyInstagramSendError(error: unknown): Failure {
  if (error instanceof MetaApiError) {
    if (error.isAuthError) {
      return { ok: false, code: "auth", retryable: false, error: `Instagram rejected our access token (${error.message}). Reconnect Instagram in Settings.` };
    }
    if ((error.subcode !== undefined && WINDOW_CLOSED_SUBCODES.has(error.subcode)) || /outside of allowed window/i.test(error.message)) {
      return { ok: false, code: "window_closed", retryable: false, error: "The 24-hour reply window has closed. Instagram only allows a reply after the customer messages you again." };
    }
    if (
      (error.subcode !== undefined && INVALID_RECIPIENT_SUBCODES.has(error.subcode)) ||
      error.code === USER_UNAVAILABLE
    ) {
      return { ok: false, code: "invalid_recipient", retryable: false, error: error.message };
    }
    if ((error.code !== undefined && RATE_LIMITED_CODES.has(error.code)) || error.status === 429) {
      return { ok: false, code: "rate_limited", retryable: true, error: "Instagram is rate limiting us. Try again in a minute." };
    }
    return { ok: false, code: "other", retryable: error.status >= 500, error: error.message };
  }

  const message = error instanceof Error ? error.message : "Unknown error sending the message.";
  return { ok: false, code: "other", retryable: true, error: message };
}

/** The Instagram API with Instagram Login. */
export class InstagramGraphProvider implements InstagramProvider {
  readonly id = "instagram_graph";
  readonly isMock = false;
  private readonly graph: InstagramGraphClient;

  constructor(
    private readonly config: InstagramConfig,
    graph?: InstagramGraphClient
  ) {
    this.graph = graph ?? new InstagramGraphClient(config);
  }

  async sendText(connection: InstagramConnection, message: OutboundInstagramText): Promise<SendOutcome> {
    try {
      const response = await this.graph.sendTextMessage(connection.accountId, connection.accessToken, {
        recipientId: message.recipientId,
        body: message.body,
      });
      return response.message_id
        ? { ok: true, providerMessageId: response.message_id }
        : { ok: false, code: "other", retryable: false, error: "Instagram accepted the request but returned no message id." };
    } catch (error) {
      return classifyInstagramSendError(error);
    }
  }

  async getProfile(connection: InstagramConnection, userId: string): Promise<InstagramProfile | null> {
    try {
      const profile = await this.graph.getUserProfile(userId, connection.accessToken);
      return { name: profile.name ?? null, username: profile.username ?? null };
    } catch {
      // A private or restricted profile still deserves a lead; it just gets a generic name.
      return null;
    }
  }

  verifyWebhook(rawBody: string, headers: HeaderReader): boolean {
    const signature = headers.get("x-hub-signature-256");
    return this.config.webhookSecrets.some((secret) => verifyWebhookSignature(rawBody, signature, secret));
  }

  parseWebhook(rawBody: string): InstagramEvent[] {
    return parseInstagramWebhook(rawBody);
  }
}
