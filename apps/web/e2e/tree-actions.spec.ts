import { test, expect } from "@playwright/test";

const email = process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";

test("tree actions: rename, move, permissions, delete via the row menu", async ({ page }) => {
  const suffix = Date.now().toString(36);
  const folderName = `Docs ${suffix}`;
  const archiveName = `Archive ${suffix}`; // slug -> archive-<suffix>, so its path contains the suffix
  const original = `Draft ${suffix}`;
  const renamed = `Final ${suffix}`;

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("link", { name: "Home" })).toBeVisible();

  // Two top-level folders; a document in the first.
  const newFolder = async (name: string) => {
    await page.getByRole("button", { name: "+ New top-level folder" }).click();
    const d = page.getByRole("dialog");
    await d.getByRole("textbox", { name: "Name" }).fill(name);
    await d.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  };
  await newFolder(folderName);
  await newFolder(archiveName);

  const folderRow = page.getByRole("listitem").filter({ hasText: folderName });
  await folderRow.locator('summary[aria-label="More actions"]').click();
  await folderRow.getByRole("button", { name: "New document" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Title" }).fill(original);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("nav").getByRole("link", { name: original })).toBeVisible();

  // Scope to the document's own <li> via its link (the ancestor folder <li> also contains the text).
  const rowFor = (title: string) =>
    page.locator("nav").getByRole("link", { name: title }).locator("xpath=ancestor::li[1]");
  const openMenu = async (title: string, action: string) => {
    const row = rowFor(title);
    await row.locator('summary[aria-label="More actions"]').click();
    await row.getByRole("button", { name: action }).click();
  };

  // Rename.
  await openMenu(original, "Rename");
  dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Title" }).fill(renamed);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("nav").getByRole("link", { name: renamed })).toBeVisible();
  await expect(page.locator("nav").getByRole("link", { name: original })).toHaveCount(0);

  // Move to the Archive folder (match its option by the unique suffix in the path).
  await openMenu(renamed, "Move");
  dialog = page.getByRole("dialog");
  const destination = dialog.getByLabel("Destination");
  const optionValue = await dialog.locator("option", { hasText: suffix }).first().getAttribute("value");
  expect(optionValue).toBeTruthy();
  await destination.selectOption(optionValue as string);
  await dialog.getByRole("button", { name: "Move" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("nav").getByRole("link", { name: renamed })).toBeVisible();

  // Permissions dialog opens.
  await openMenu(renamed, "Permissions");
  await expect(page.getByRole("dialog").getByText("Permissions")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Delete.
  await openMenu(renamed, "Delete");
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator("nav").getByRole("link", { name: renamed })).toHaveCount(0);
});
