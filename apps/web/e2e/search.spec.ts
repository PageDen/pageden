import { test, expect } from "@playwright/test";

const email = process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";

test("search: title + body search from sidebar and command palette, open a result", async ({ page }) => {
  const suffix = Date.now().toString(36);
  const folderName = `Search ${suffix}`;
  const documentTitle = `Onboarding ${suffix}`;
  const bodyToken = `needle${suffix}`; // only in the body

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("link", { name: "Home" })).toBeVisible();

  // Folder + document with a body-only token.
  await page.getByRole("button", { name: "+ New top-level folder" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name" }).fill(folderName);
  await dialog.getByRole("button", { name: "Save" }).click();
  const folderRow = page.getByRole("listitem").filter({ hasText: folderName });
  await folderRow.locator('summary[aria-label="More actions"]').click();
  await folderRow.getByRole("button", { name: "New document" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Title" }).fill(documentTitle);
  await dialog.getByRole("button", { name: "Save" }).click();
  await page.locator("nav").getByRole("link", { name: documentTitle }).click();
  const editor = page.getByLabel("Document body");
  await editor.click();
  await page.keyboard.type(`Body content ${bodyToken}`);
  await page.getByRole("button", { name: "Save" }).click();

  // Sidebar: title search finds it.
  const sidebar = page.getByLabel("Search documents");
  await sidebar.fill(documentTitle);
  await expect(page.locator("nav").getByRole("link", { name: new RegExp(documentTitle) })).toBeVisible();

  // Sidebar: body-only token finds it and highlights the match.
  await sidebar.fill(bodyToken);
  await expect(page.locator("nav").getByRole("link", { name: new RegExp(documentTitle) })).toBeVisible();
  await expect(page.locator("mark").filter({ hasText: bodyToken }).first()).toBeVisible();
  await sidebar.fill("");

  // Command palette: search by body token, then open the result by pressing Enter.
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Search documents" });
  await expect(palette).toBeVisible();
  await palette.getByLabel("Search document content").fill(bodyToken);
  await expect(palette.locator('li[role="option"]').filter({ hasText: documentTitle }).first()).toBeVisible();
  await palette.getByLabel("Search document content").press("Enter");
  await expect(palette).not.toBeVisible();
  // Navigated to the document.
  await expect(page.getByLabel("Document body")).toContainText(bodyToken);
});
