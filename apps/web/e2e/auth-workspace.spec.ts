import { test, expect } from "@playwright/test";

// Registration / workspace-creation UI. The e2e server runs self-hosted
// (CLOUD_HOSTED unset), so the Workspace URL (subdomain) field is hidden — it is
// a cloud-only field. We assert the self-hosted register flow lands directly in
// the new workspace.

test("auth/workspace: register lands directly in the new workspace", async ({ page }) => {
  const suffix = Date.now().toString(36);

  await page.goto("/register");
  await page.getByLabel("Name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill(`ada-${suffix}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("correct-horse-battery");
  await page.getByLabel("Company").fill(`Acme ${suffix}`);

  // Self-hosted: no Workspace URL field is shown (subdomains are cloud-only).
  await expect(page.getByLabel("Workspace URL")).toHaveCount(0);

  // Submit -> account created and signed in, landing directly in the new
  // (empty) workspace with the getting-started cards.
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("link", { name: "Home" })).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole("heading", { name: "Your workspace is ready" })).toBeVisible();
});
