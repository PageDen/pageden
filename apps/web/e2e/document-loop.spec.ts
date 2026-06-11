import { test, expect } from "@playwright/test";

const email = process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";

test("first-build loop: login → create folder + document → edit → save → persists", async ({ page }) => {
  const suffix = Date.now().toString(36);
  const folderName = `Engineering ${suffix}`;
  const documentTitle = `Runbook ${suffix}`;
  const bodyToken = `findme${suffix}`; // appears only in the body, never in the title

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();

  // Landed in the workspace shell.
  await expect(page.getByRole("link", { name: "Home" })).toBeVisible();

  // Create a top-level folder.
  await page.getByRole("button", { name: "+ New top-level folder" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name" }).fill(folderName);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(folderName, { exact: true })).toBeVisible();

  // Create a document inside it.
  const folderRow = page.getByRole("listitem").filter({ hasText: folderName });
  await folderRow.hover();
  await folderRow.locator('summary[aria-label="More actions"]').click();
  await folderRow.getByRole("button", { name: "New document" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Title" }).fill(documentTitle);
  await dialog.getByRole("button", { name: "Save" }).click();

  // Open the document and edit it.
  await page.locator("nav").getByRole("link", { name: documentTitle }).click();
  const editor = page.getByLabel("Document body");
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.type(`# Hello E2E ${bodyToken}`);
  await page.getByRole("button", { name: "Save" }).click();

  // Content search (sidebar): a body-only token finds the document and highlights the match.
  const sidebarSearch = page.getByLabel("Search documents");
  await sidebarSearch.fill(bodyToken);
  await expect(page.locator("nav").getByRole("link", { name: new RegExp(documentTitle) })).toBeVisible();
  await expect(page.locator("mark").filter({ hasText: bodyToken }).first()).toBeVisible();
  await sidebarSearch.fill("");

  // Command palette (⌘K / Ctrl-K): same content search with a highlighted snippet.
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Search documents" });
  await expect(palette).toBeVisible();
  await palette.getByLabel("Search document content").fill(bodyToken);
  await expect(palette.locator("mark").filter({ hasText: bodyToken }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).not.toBeVisible();

  // Navigate via a title search, then reload — the change persisted on the server.
  await sidebarSearch.fill(documentTitle);
  await expect(page.locator("nav").getByRole("link", { name: new RegExp(documentTitle) })).toBeVisible();
  await page.locator("nav").getByRole("link", { name: new RegExp(documentTitle) }).click();
  await page.reload();
  await expect(page.getByLabel("Document body")).toContainText("Hello E2E");
});
