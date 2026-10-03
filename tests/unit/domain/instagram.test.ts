import { describe, expect, it } from "vitest";
import {
  describeInstagramMessage,
  instagramContactName,
  nextInstagramStatus,
  shouldRefreshToken,
} from "@/lib/domain/instagram";

describe("describeInstagramMessage", () => {
  it("shows text as-is and labels everything else", () => {
    expect(describeInstagramMessage("text", "Hello")).toBe("Hello");
    expect(describeInstagramMessage("image", null)).toBe("[Photo]");
    expect(describeInstagramMessage("audio", null)).toBe("[Voice message]");
    expect(describeInstagramMessage("story_mention", null)).toBe("[Mentioned you in their story]");
    expect(describeInstagramMessage("unsupported", null)).toBe("[Unsupported message]");
  });

  it("says when text is a reply to a story", () => {
    expect(describeInstagramMessage("story_reply", "Love it")).toBe("Replied to your story: Love it");
    expect(describeInstagramMessage("story_reply", null)).toBe("[Replied to your story]");
  });
});

describe("nextInstagramStatus", () => {
  it("marks a sent message read, and never moves a final status", () => {
    expect(nextInstagramStatus("sent", "read")).toBe("read");
    expect(nextInstagramStatus("read", "read")).toBe("read");
    expect(nextInstagramStatus("failed", "read")).toBe("failed");
    expect(nextInstagramStatus("received", "read")).toBe("received");
  });

  it("lets an unsend win over anything, once", () => {
    expect(nextInstagramStatus("received", "deleted")).toBe("deleted");
    expect(nextInstagramStatus("deleted", "deleted")).toBe("deleted");
    expect(nextInstagramStatus("deleted", "read")).toBe("deleted");
  });
});

describe("instagramContactName", () => {
  it("splits a display name", () => {
    expect(instagramContactName({ name: "Riya  Sharma Kapoor", username: "riya" })).toEqual({
      firstName: "Riya",
      lastName: "Sharma Kapoor",
    });
  });

  it("falls back to the @username, then to a generic name", () => {
    expect(instagramContactName({ name: null, username: "riya.s" })).toEqual({ firstName: "@riya.s", lastName: null });
    expect(instagramContactName({ name: " ", username: null })).toEqual({ firstName: "Instagram user", lastName: null });
    expect(instagramContactName(null)).toEqual({ firstName: "Instagram user", lastName: null });
  });
});

describe("shouldRefreshToken", () => {
  const now = new Date("2026-10-02T03:00:00Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString();

  it("refreshes a week-old token", () => {
    expect(shouldRefreshToken({ refreshedAt: daysAgo(8), expiresAt: inDays(52) }, now)).toBe(true);
  });

  it("leaves a recently refreshed token alone", () => {
    expect(shouldRefreshToken({ refreshedAt: daysAgo(3), expiresAt: inDays(57) }, now)).toBe(false);
  });

  it("never tries within 24 hours of the last refresh — Instagram refuses", () => {
    expect(shouldRefreshToken({ refreshedAt: daysAgo(0.5), expiresAt: inDays(2) }, now)).toBe(false);
  });

  it("refreshes early when expiry is close", () => {
    expect(shouldRefreshToken({ refreshedAt: daysAgo(2), expiresAt: inDays(5) }, now)).toBe(true);
  });

  it("doesn't try to refresh an expired token (the org must reconnect)", () => {
    expect(shouldRefreshToken({ refreshedAt: daysAgo(70), expiresAt: daysAgo(10) }, now)).toBe(false);
  });

  it("refreshes when it has never been refreshed", () => {
    expect(shouldRefreshToken({ refreshedAt: null, expiresAt: null }, now)).toBe(true);
  });
});
