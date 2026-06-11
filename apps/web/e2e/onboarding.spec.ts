import { test, expect } from "@playwright/test";

const email = process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";

test("onboarding: guides a signed-in user to vault import and agent setup", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("link", { name: "Home" })).toBeVisible();

  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "Bring your vault. Connect your agent." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Create or choose workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Import your Obsidian vault" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connect an AI agent" })).toBeVisible();

  await page.getByRole("link", { name: "Import vault" }).click();
  await expect(page.getByRole("heading", { name: "Import an Obsidian vault" })).toBeVisible();

  await page.goto("/onboarding");
  await page.getByRole("link", { name: "Connect agent" }).click();
  await expect(page.getByRole("heading", { name: /Connect Codex, Claude, Hermes/ })).toBeVisible();
});
