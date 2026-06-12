import { test, expect, type Page } from "@playwright/test";

const email = process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";
const ORIGIN = "http://localhost:3000";

async function login(page: Page, user: string, pass: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user);
  await page.getByLabel("Password", { exact: true }).fill(pass);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
}

test("permissions UI: viewer is read-only, editor can save", async ({ page, browser }) => {
  const suffix = Date.now().toString(36);
  const folderName = `Perms ${suffix}`;
  const docTitle = `Shared ${suffix}`;
  const memberEmail = `member-${suffix}@example.com`;
  const memberPass = "correct-horse-2";

  await login(page, email, password);

  // Folder + document; capture workspaceId + documentId from the URL.
  await page.getByRole("button", { name: "+ New top-level folder" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name" }).fill(folderName);
  await dialog.getByRole("button", { name: "Save" }).click();
  const folderRow = page.getByRole("listitem").filter({ hasText: folderName });
  await folderRow.locator('summary[aria-label="More actions"]').click();
  await folderRow.getByRole("button", { name: "New document" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Title" }).fill(docTitle);
  await dialog.getByRole("button", { name: "Save" }).click();
  await page.locator("nav").getByRole("link", { name: docTitle }).click();
  await expect(page.getByRole("heading", { name: docTitle })).toBeVisible();
  const m = page.url().match(/\/w\/([^/]+)\/d\/([^/?#]+)/);
  expect(m).toBeTruthy();
  const [, workspaceId, documentId] = m as RegExpMatchArray;

  // Create a second workspace member via the API (Origin set for the CSRF guard).
  const created = await page.request.post(`${ORIGIN}/api/users`, {
    headers: { origin: ORIGIN },
    data: { workspaceId, email: memberEmail, name: "Member", password: memberPass, role: "member" },
  });
  expect(created.ok()).toBeTruthy();
  const memberId = (await created.json()).id as string;

  // Grant the member VIEWER through the permissions dialog UI.
  const docRow = page.locator("nav").getByRole("link", { name: docTitle }).locator("xpath=ancestor::li[1]");
  await docRow.locator('summary[aria-label="More actions"]').click();
  await docRow.getByRole("button", { name: "Permissions" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("Subject", { exact: true }).selectOption({ label: memberEmail }); // role defaults to viewer
  await dialog.getByRole("button", { name: "Add" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Member context #1: viewer — can open the document but it is read-only.
  const viewerCtx = await browser.newContext();
  const viewer = await viewerCtx.newPage();
  await login(viewer, memberEmail, memberPass);
  await viewer.goto(`/w/${workspaceId}/d/${documentId}`);
  await expect(viewer.getByRole("heading", { name: docTitle })).toBeVisible();
  await expect(viewer.getByText("Read-only")).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(viewer.getByLabel("Document body")).toHaveCount(0);
  await viewerCtx.close();

  // Promote the member to EDITOR via the API (fresh version for optimistic concurrency).
  const permsRes = await page.request.get(`${ORIGIN}/api/documents/${documentId}/permissions`, {
    headers: { origin: ORIGIN },
  });
  const version = (await permsRes.json()).version as string;
  const put = await page.request.put(`${ORIGIN}/api/documents/${documentId}/permissions`, {
    headers: { origin: ORIGIN },
    data: { permissions: [{ subjectType: "user", subjectId: memberId, role: "editor" }], version },
  });
  expect(put.ok()).toBeTruthy();

  // Member context #2: editor — can edit and save.
  const editorCtx = await browser.newContext();
  const editorPage = await editorCtx.newPage();
  await login(editorPage, memberEmail, memberPass);
  await editorPage.goto(`/w/${workspaceId}/d/${documentId}`);
  await editorPage.getByRole("button", { name: "Edit" }).click();
  await expect(editorPage.getByLabel("Document body")).toBeVisible();
  await expect(editorPage.getByRole("button", { name: "Save" })).toBeVisible();
  await editorCtx.close();
});
