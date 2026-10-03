import { describe, expect, it } from "vitest";
import { contactIdentity, displayName, hasContactChannel, normalizeEmail } from "@/lib/domain/contact";

describe("normalizeEmail", () => {
  it("lowercases and trims so case variants dedupe together", () => {
    expect(normalizeEmail("  Priya.Sharma@Example.COM ")).toBe("priya.sharma@example.com");
  });

  it.each([[""], [null], [undefined], ["not-an-email"], ["a@b"], ["two words@x.com"]])(
    "rejects %j",
    (raw) => {
      expect(normalizeEmail(raw as string | null | undefined)).toBeNull();
    }
  );
});

describe("contactIdentity", () => {
  it("derives phone, additional phone and email keys", () => {
    expect(
      contactIdentity({ phone: "98765 43210", additionalPhone: "+91 80000 12345", email: "A@B.co" })
    ).toEqual({
      phoneNormalized: "+919876543210",
      additionalPhoneNormalized: "+918000012345",
      emailNormalized: "a@b.co",
    });
  });

  it("leaves an unusable field null instead of storing garbage", () => {
    const identity = contactIdentity({ phone: "nope", email: "x@y.com" });
    expect(identity.phoneNormalized).toBeNull();
    expect(identity.emailNormalized).toBe("x@y.com");
  });
});

describe("hasContactChannel", () => {
  it("requires a phone or an email", () => {
    expect(hasContactChannel(contactIdentity({}))).toBe(false);
    expect(hasContactChannel(contactIdentity({ phone: "9876543210" }))).toBe(true);
    expect(hasContactChannel(contactIdentity({ email: "a@b.co" }))).toBe(true);
  });

  it("does not count an additional phone alone as a channel", () => {
    expect(hasContactChannel(contactIdentity({ additionalPhone: "9876543210" }))).toBe(false);
  });

  it("counts an Instagram id as a way to reach someone who only ever DMed", () => {
    expect(contactIdentity({ instagramUserId: " IGSID-1 " }).instagramUserId).toBe("IGSID-1");
    expect(hasContactChannel(contactIdentity({ instagramUserId: "IGSID-1" }))).toBe(true);
    expect(hasContactChannel(contactIdentity({ instagramUserId: "  " }))).toBe(false);
  });
});

describe("displayName", () => {
  it("joins first and last name", () => {
    expect(displayName({ firstName: "Asha", lastName: "Rao" })).toBe("Asha Rao");
    expect(displayName({ firstName: "Asha", lastName: null })).toBe("Asha");
  });
});
