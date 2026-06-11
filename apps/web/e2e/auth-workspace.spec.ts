import { test, expect } from "@playwright/test";

// Registration / workspace-creation UI. Signup is open by default (the server only blocks it
// when AUTH_ALLOW_SIGNUP=false). We don't test real wildcard subdomain ROUTING here — that
// needs CLOUD_HOSTED=true + Host simulation — only the register form + availability behavior.

test("auth/workspace: register with company + workspace URL, with availability + error feedback", async ({ page }) => {
  const suffix = Date.now().toString(36);
  const sub = `acme${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, "");

  await page.goto("/register");
  await page.getByLabel("Name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill(`ada-${suffix}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct-horse-battery");
  await page.getByLabel("Company").fill(`Acme ${suffix}`);

  const url = page.getByLabel("Workspace URL");

  // Too short -> validation reason.
  await url.fill("a");
  await expect(page.getByText(/at least 2 characters/i)).toBeVisible();

  // Reserved word -> reserved reason.
  await url.fill("admin");
  await expect(page.getByText(/reserved/i)).toBeVisible();

  // A free, valid URL -> Available.
  await url.fill(sub);
  await expect(page.getByText("Available", { exact: true })).toBeVisible();

  // Submit -> account created and signed in.
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("link", { name: "Home" })).toBeVisible({ timeout: 15000 });
});
