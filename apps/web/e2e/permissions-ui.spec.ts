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

  // Folder + document; capture workspaceId from the URL and documentId from the tree API.
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
  const m = page.url().match(/\/w\/([^/]+)/);
  expect(m).toBeTruthy();
  const [, workspaceId] = m as RegExpMatchArray;
  const treeRes = await page.request.get(`${ORIGIN}/api/documents/tree?workspaceId=${encodeURIComponent(workspaceId)}`, {
    headers: { origin: ORIGIN },
  });
  expect(treeRes.ok()).toBeTruthy();
  const tree = await treeRes.json() as { documents: Array<{ id: string; title: string }> };
  const documentId = tree.documents.find((doc) => doc.title === docTitle)?.id;
  if (!documentId) throw new Error("Created document was not found in the tree response.");

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
  // Phase 1 unified picker (#70): type to filter, click the matching row.
  // Role defaults to viewer; Phase 3 (#71+): the add fires optimistically, no
  // Save button to click — just close the dialog with Done.
  await dialog.getByLabel("Add people, groups, or invite by email").fill(memberEmail);
  await dialog.getByRole("option", { name: new RegExp(memberEmail) }).first().click();
  // Wait for the added row to appear in the People with access list.
  await expect(dialog.getByText(memberEmail).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();
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
