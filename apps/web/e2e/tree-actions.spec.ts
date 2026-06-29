import { test, expect, type Page } from "@playwright/test";

const email = process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  const homeLink = page.getByRole("link", { name: "Home" });
  const workspaceChooser = page.getByRole("heading", { name: "Choose a workspace" });
  await expect(homeLink.or(workspaceChooser).first()).toBeVisible();
  if (await workspaceChooser.isVisible()) {
    await page.getByRole("link", { name: /Default Workspace/i }).click();
  }
  await expect(homeLink).toBeVisible();
}

test("tree actions: rename, move, permissions, delete via the row menu", async ({ page }) => {
  const suffix = Date.now().toString(36);
  const folderName = `Docs ${suffix}`;
  const archiveName = `Archive ${suffix}`; // slug -> archive-<suffix>, so its path contains the suffix
  const original = `Draft ${suffix}`;
  const renamed = `Final ${suffix}`;

  await login(page);

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
    await row.getByRole("button", { name: action, exact: true }).click();
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

  // Permissions dialog opens. The H2 heading is "Share" and an action button
  // can also contain that word; scope the assertion to the heading to avoid
  // Playwright's strict-mode multi-match rejection.
  await openMenu(renamed, "Permissions");
  await expect(page.getByRole("dialog").locator("h2").getByText("Share")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Delete.
  await openMenu(renamed, "Delete");
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(page.locator("nav").getByRole("link", { name: renamed })).toHaveCount(0);
});

test("tree actions: exposes workspace transfer in self-host", async ({ page }) => {
  const suffix = Date.now().toString(36);
  const folderName = `Self Hosted ${suffix}`;
  const docTitle = `Local Only ${suffix}`;

  await login(page);

  await page.getByRole("button", { name: "+ New top-level folder" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name" }).fill(folderName);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(folderName, { exact: true })).toBeVisible();

  const folderRow = page.getByText(folderName, { exact: true }).locator("xpath=ancestor::div[contains(@class, 'group')][1]");
  await folderRow.locator('summary[aria-label="More actions"]').click();
  await expect(folderRow.getByRole("button", { name: "Move to workspace" })).toHaveCount(1);
  await folderRow.getByRole("button", { name: "New document" }).click();

  dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Title" }).fill(docTitle);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("nav").getByRole("link", { name: docTitle })).toBeVisible();

  const docRow = page.locator("nav").getByRole("link", { name: docTitle }).locator("xpath=ancestor::li[1]");
  await docRow.locator('summary[aria-label="More actions"]').click();
  await expect(docRow.getByRole("button", { name: "Move to workspace" })).toHaveCount(1);
});

test("tree folders render in natural sorted order", async ({ page }) => {
  const suffix = Date.now().toString(36);
  const parentName = `Sort Parent ${suffix}`;
  const childNames = [
    `Phase 5 ${suffix}`,
    `Phase 4 ${suffix}`,
    `Governance ${suffix}`,
    `Phase 1 ${suffix}`,
    `Phase 10 ${suffix}`,
    `Phase 2 ${suffix}`,
    `Phase 3 ${suffix}`,
  ];

  await login(page);

  await page.getByRole("button", { name: "+ New top-level folder" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name" }).fill(parentName);
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(parentName, { exact: true })).toBeVisible();

  const parentRow = page.getByText(parentName, { exact: true }).locator("xpath=ancestor::div[contains(@class, 'group')][1]");
  for (const childName of childNames) {
    await parentRow.locator('summary[aria-label="More actions"]').click();
    await parentRow.getByRole("button", { name: "New subfolder" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Name" }).fill(childName);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(childName, { exact: true })).toBeVisible();
  }

  const parentItem = page.getByText(parentName, { exact: true }).locator("xpath=ancestor::li[1]");
  await expect(parentItem.locator("xpath=./ul/li/div/button/span")).toHaveText([
    `Governance ${suffix}`,
    `Phase 1 ${suffix}`,
    `Phase 2 ${suffix}`,
    `Phase 3 ${suffix}`,
    `Phase 4 ${suffix}`,
    `Phase 5 ${suffix}`,
    `Phase 10 ${suffix}`,
  ]);
});
