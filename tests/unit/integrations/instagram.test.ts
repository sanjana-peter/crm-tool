import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaApiError } from "@/lib/integrations/meta/client";
import { InstagramGraphClient } from "@/lib/integrations/instagram/client";
import type { InstagramConfig } from "@/lib/integrations/instagram/config";
import { classifyInstagramSendError, InstagramGraphProvider } from "@/lib/integrations/instagram/graph-adapter";
import {
  buildMockInstagramDm,
  MockInstagramProvider,
  mockInstagramSenderId,
} from "@/lib/integrations/instagram/mock-adapter";
import { parseInstagramWebhook } from "@/lib/integrations/instagram/webhook-format";

const config: InstagramConfig = {
  appId: "ig-app",
  appSecret: "ig-secret",
  webhookSecrets: ["ig-secret", "meta-secret"],
  webhookVerifyToken: "verify",
  graphVersion: "v23.0",
  appUrl: "http://localhost:3000",
};

const connection = { accountId: "17841400000000001", accessToken: "IGAA-super-secret-token" };

function sign(body: string, secret: string) {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null });

const envelope = (messaging: unknown[], object = "instagram") =>
  JSON.stringify({ object, entry: [{ id: "17841400000000001", time: 1790000000000, messaging }] });

afterEach(() => vi.unstubAllGlobals());

describe("parseInstagramWebhook", () => {
  it("extracts a text DM with the sender's IGSID", () => {
    const events = parseInstagramWebhook(
      envelope([
        {
          sender: { id: "IGSID-1" },
          recipient: { id: "17841400000000001" },
          timestamp: 1790000000000,
          message: { mid: "aWdf.A", text: "Hi, what are the fees?" },
        },
      ])
    );
    expect(events).toEqual([
      {
        kind: "message",
        accountId: "17841400000000001",
        providerMessageId: "aWdf.A",
        senderId: "IGSID-1",
        messageType: "text",
        text: "Hi, what are the fees?",
        attachmentUrl: null,
        occurredAt: new Date(1790000000000).toISOString(),
      },
    ]);
  });

  it("accepts a timestamp in seconds as well as milliseconds", () => {
    const [event] = parseInstagramWebhook(
      envelope([{ sender: { id: "S" }, recipient: { id: "R" }, timestamp: 1790000000, message: { mid: "m", text: "x" } }])
    );
    expect(event.occurredAt).toBe(new Date(1790000000 * 1000).toISOString());
  });

  it("classifies attachments, story replies and story mentions", () => {
    const events = parseInstagramWebhook(
      envelope([
        { sender: { id: "S" }, recipient: { id: "R" }, message: { mid: "img", attachments: [{ type: "image", payload: { url: "https://cdn/x.jpg" } }] } },
        { sender: { id: "S" }, recipient: { id: "R" }, message: { mid: "story", text: "Love this!", reply_to: { story: { id: "st1", url: "https://cdn/s" } } } },
        { sender: { id: "S" }, recipient: { id: "R" }, message: { mid: "mention", attachments: [{ type: "story_mention", payload: { url: "https://cdn/m" } }] } },
        { sender: { id: "S" }, recipient: { id: "R" }, message: { mid: "odd", is_unsupported: true } },
      ])
    );
    expect(events.map((e) => (e.kind === "message" ? [e.messageType, e.attachmentUrl] : null))).toEqual([
      ["image", "https://cdn/x.jpg"],
      ["story_reply", null],
      ["story_mention", "https://cdn/m"],
      ["unsupported", null],
    ]);
  });

  it("separates the business's own messages (echoes) from the customer's", () => {
    const [event] = parseInstagramWebhook(
      envelope([{ sender: { id: "17841400000000001" }, recipient: { id: "IGSID-1" }, message: { mid: "echo.1", text: "Thanks!", is_echo: true } }])
    );
    expect(event).toMatchObject({ kind: "echo", recipientId: "IGSID-1", providerMessageId: "echo.1", text: "Thanks!" });
  });

  it("extracts unsends and read receipts", () => {
    const events = parseInstagramWebhook(
      envelope([
        { sender: { id: "IGSID-1" }, recipient: { id: "R" }, message: { mid: "gone", is_deleted: true } },
        { sender: { id: "IGSID-1" }, recipient: { id: "R" }, read: { mid: "seen.1" } },
      ])
    );
    expect(events).toEqual([
      expect.objectContaining({ kind: "deleted", providerMessageId: "gone", senderId: "IGSID-1" }),
      expect.objectContaining({ kind: "read", providerMessageId: "seen.1", senderId: "IGSID-1" }),
    ]);
  });

  it("drops malformed entries and other webhook objects instead of guessing", () => {
    expect(parseInstagramWebhook(envelope([{ sender: { id: "S" } }]))).toEqual([]);
    expect(parseInstagramWebhook(envelope([{ sender: { id: "S" }, recipient: { id: "R" }, message: { text: "no mid" } }]))).toEqual([]);
    expect(parseInstagramWebhook(envelope([{ sender: { id: "S" }, recipient: { id: "R" }, reaction: { mid: "m" } }]))).toEqual([]);
    expect(parseInstagramWebhook(envelope([], "page"))).toEqual([]);
    expect(parseInstagramWebhook(JSON.stringify({}))).toEqual([]);
  });

  it("throws on a body that isn't JSON", () => {
    expect(() => parseInstagramWebhook("not json")).toThrow();
  });
});

describe("classifyInstagramSendError", () => {
  const meta = (message: string, status: number, code?: number, subcode?: number) =>
    new MetaApiError(message, status, code, subcode);

  it.each([
    [meta("token expired", 401, 190), "auth", false],
    [meta("This message is sent outside of allowed window.", 400, 10, 2534022), "window_closed", false],
    [meta("User unavailable", 400, 551), "invalid_recipient", false],
    [meta("No matching user", 400, 100, 2534014), "invalid_recipient", false],
    [meta("Application request limit reached", 400, 4), "rate_limited", true],
    [meta("too many", 429), "rate_limited", true],
    [meta("boom", 500, 1), "other", true],
    [meta("bad request", 400, 100), "other", false],
  ] as const)("maps %j to %s (retryable: %s)", (error, code, retryable) => {
    expect(classifyInstagramSendError(error)).toMatchObject({ ok: false, code, retryable });
  });

  it("tells the user to reconnect Instagram on an auth failure", () => {
    expect(classifyInstagramSendError(meta("Invalid OAuth access token", 401, 190)).error).toMatch(/reconnect instagram/i);
  });

  it("treats a network failure as retryable", () => {
    expect(classifyInstagramSendError(new TypeError("fetch failed"))).toMatchObject({ code: "other", retryable: true });
  });
});

function stubFetch(...responses: Array<{ ok?: boolean; status?: number; body: unknown }>) {
  let call = 0;
  const fetchMock = vi.fn(async () => {
    const response = responses[Math.min(call++, responses.length - 1)];
    return { ok: response.ok ?? true, status: response.status ?? 200, json: async () => response.body };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("InstagramGraphProvider", () => {
  it("sends text to the account's messages endpoint addressed by IGSID", async () => {
    const fetchMock = stubFetch({ body: { recipient_id: "IGSID-1", message_id: "aWdf.SENT" } });
    const outcome = await new InstagramGraphProvider(config).sendText(connection, { recipientId: "IGSID-1", body: "Hello!" });

    expect(outcome).toEqual({ ok: true, providerMessageId: "aWdf.SENT" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin).toBe("https://graph.instagram.com");
    expect(url.pathname).toBe("/v23.0/17841400000000001/messages");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ recipient: { id: "IGSID-1" }, message: { text: "Hello!" } });
  });

  it("returns a classified failure instead of throwing", async () => {
    stubFetch({ ok: false, status: 400, body: { error: { message: "outside of allowed window", code: 10, error_subcode: 2534022 } } });
    const outcome = await new InstagramGraphProvider(config).sendText(connection, { recipientId: "IGSID-1", body: "Hi" });
    expect(outcome).toMatchObject({ ok: false, code: "window_closed" });
  });

  it("looks up a sender's name and username, and shrugs off a private profile", async () => {
    stubFetch({ body: { name: "Riya Sharma", username: "riya.sharma" } });
    const provider = new InstagramGraphProvider(config);
    expect(await provider.getProfile(connection, "IGSID-1")).toEqual({ name: "Riya Sharma", username: "riya.sharma" });

    stubFetch({ ok: false, status: 400, body: { error: { message: "no permission", code: 100 } } });
    expect(await provider.getProfile(connection, "IGSID-1")).toBeNull();
  });

  it("verifies a webhook signed with either the Instagram or the Meta app secret, and nothing else", () => {
    const body = envelope([]);
    const provider = new InstagramGraphProvider(config);
    expect(provider.verifyWebhook(body, headers({ "x-hub-signature-256": sign(body, "ig-secret") }))).toBe(true);
    expect(provider.verifyWebhook(body, headers({ "x-hub-signature-256": sign(body, "meta-secret") }))).toBe(true);
    expect(provider.verifyWebhook(body, headers({ "x-hub-signature-256": sign(body, "attacker") }))).toBe(false);
    expect(provider.verifyWebhook(body, headers({}))).toBe(false);
  });
});

describe("InstagramGraphClient OAuth", () => {
  it("exchanges the code with the app credentials, accepting the wrapped response shape", async () => {
    const fetchMock = stubFetch({ body: { data: [{ access_token: "short", user_id: 1784, permissions: ["instagram_business_basic"] }] } });
    const token = await new InstagramGraphClient(config).exchangeCodeForToken("CODE", "http://localhost:3000/cb");

    expect(token).toEqual({ access_token: "short", user_id: "1784", permissions: ["instagram_business_basic"] });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.instagram.com/oauth/access_token");
    const form = init.body as URLSearchParams;
    expect(form.get("client_secret")).toBe("ig-secret");
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("CODE");
  });

  it("refreshes a long-lived token with the ig_refresh_token grant", async () => {
    const fetchMock = stubFetch({ body: { access_token: "renewed", token_type: "bearer", expires_in: 5184000 } });
    const token = await new InstagramGraphClient(config).refreshLongLivedToken("old");
    expect(token.access_token).toBe("renewed");
    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(url.pathname).toBe("/refresh_access_token");
    expect(url.searchParams.get("grant_type")).toBe("ig_refresh_token");
  });

  it("surfaces Instagram's flat error format as a MetaApiError", async () => {
    stubFetch({ ok: false, status: 400, body: { error_type: "OAuthException", code: 400, error_message: "Invalid code" } });
    await expect(new InstagramGraphClient(config).exchangeCodeForToken("bad", "x")).rejects.toMatchObject({
      name: "MetaApiError",
      message: "Invalid code",
    });
  });
});

describe("MockInstagramProvider", () => {
  const provider = new MockInstagramProvider("mock-secret");

  it("pretends to send, except for the failure triggers", async () => {
    expect(await provider.sendText(connection, { recipientId: "mock.riya", body: "Hi" })).toMatchObject({ ok: true });
    expect(await provider.sendText(connection, { recipientId: "mock.user0000", body: "Hi" })).toMatchObject({ ok: false, code: "invalid_recipient" });
    expect(await provider.sendText(connection, { recipientId: "mock.user9999", body: "Hi" })).toMatchObject({ ok: false, code: "rate_limited", retryable: true });
  });

  it("derives a demo sender's username from their id", async () => {
    expect(mockInstagramSenderId("@Riya.Sharma")).toBe("mock.riya.sharma");
    expect(await provider.getProfile(connection, "mock.riya.sharma")).toEqual({ name: null, username: "riya.sharma" });
    expect(await provider.getProfile(connection, "IGSID-real")).toBeNull();
  });

  it("builds a DM in the real webhook shape that the real parser reads", () => {
    const body = buildMockInstagramDm({ accountId: "mock:org", senderId: "mock.riya", text: "Hello", messageId: "m1" });
    expect(provider.verifyWebhook(body, headers({ "x-mock-signature": sign(body, "mock-secret") }))).toBe(true);
    expect(provider.parseWebhook(body)).toEqual([
      expect.objectContaining({ kind: "message", accountId: "mock:org", senderId: "mock.riya", text: "Hello", providerMessageId: "m1" }),
    ]);
  });
});
