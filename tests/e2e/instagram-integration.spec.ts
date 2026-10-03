import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";

// The Instagram DM flow in demo mode, driven through the real UI: a DM from a
// stranger becomes a lead, a salesperson replies within the 24-hour window,
// and "STOP" turns replies off. The services import `server-only`, so
// everything goes through the pages.

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
}

test.describe("Instagram DMs (demo mode)", () => {
  test("a DM from someone new becomes a lead that the team can reply to", async ({ page }) => {
    const username = `e2e.${randomUUID().slice(0, 8)}`;
    await login(page, "admin@summitsales.test");

    await page.goto("/settings/integrations/instagram");
    await expect(page.getByText("Demo mode").first()).toBeVisible();
    await page.getByLabel("From").fill(username);
    await page.getByLabel("Their message").fill("Hi! Do you have a weekend batch?");
    await page.getByRole("button", { name: "Deliver DM" }).click();
    await page.getByRole("link", { name: "Open the lead" }).click();

    await expect(page.getByRole("heading", { name: `@${username}` })).toBeVisible();
    await expect(page.getByText("Hi! Do you have a weekend batch?").first()).toBeVisible();
    await expect(page.getByText(/New lead from an Instagram DM/).first()).toBeVisible();

    await page.getByRole("textbox", { name: "Reply on Instagram" }).fill("Yes — Saturdays at 10am.");
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect(page.getByRole("list", { name: "Instagram conversation" }).getByText("Yes — Saturdays at 10am.")).toBeVisible();

    await page.getByRole("button", { name: "Simulate Instagram DM" }).click();
    await page.getByRole("dialog").getByLabel("Their message").fill("STOP");
    await page.getByRole("button", { name: "Deliver reply" }).click();
    await expect(page.getByText(/replies are turned off/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Send reply" })).toHaveCount(0);
  });

  test("the integrations overview lists Instagram", async ({ page }) => {
    await login(page, "admin@summitsales.test");
    await page.goto("/settings/integrations");
    await expect(page.getByRole("link", { name: "Instagram DMs" })).toBeVisible();
  });
});
