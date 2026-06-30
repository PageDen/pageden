import { expect, test, type APIResponse, type Page } from "@playwright/test";

const email = process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";
const ORIGIN = "http://localhost:3000";
const csrfHeaders = { origin: ORIGIN };

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

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<T>;
}

test("public folder manual: opens landing, stable page URL, and mobile page switcher", async ({ page, browser }) => {
  const suffix = Date.now().toString(36);
  await login(page);
  const workspaceId = new URL(page.url()).pathname.match(/\/w\/([^/]+)/)?.[1];
  expect(workspaceId).toBeTruthy();

  const folderName = `Manual ${suffix}`;
  const folder = await json<{ id: string }>(await page.request.post(`${ORIGIN}/api/folders`, {
    headers: csrfHeaders,
    data: { workspaceId, parentFolderId: null, name: folderName, slug: slug(folderName) },
  }));
  const firstTitle = `A Overview ${suffix}`;
  const secondTitle = `B Install ${suffix}`;
  const first = await json<{ id: string }>(await page.request.post(`${ORIGIN}/api/documents`, {
    headers: csrfHeaders,
    data: { workspaceId, folderId: folder.id, title: firstTitle, slug: slug(firstTitle), content: `# ${firstTitle}\n\nWelcome ${suffix}\n` },
  }));
  const second = await json<{ id: string }>(await page.request.post(`${ORIGIN}/api/documents`, {
    headers: csrfHeaders,
    data: { workspaceId, folderId: folder.id, title: secondTitle, slug: slug(secondTitle), content: `# ${secondTitle}\n\nInstall body ${suffix}\n` },
  }));
  expect(first.id).toBeTruthy();

  const share = await json<{ share: { slug: string } }>(await page.request.post(`${ORIGIN}/api/folders/${folder.id}/share`, { headers: csrfHeaders, data: {} }));

  const publicPage = await browser.newPage();
  await publicPage.goto(`${ORIGIN}/s/${share.share.slug}`);
  await expect(publicPage.locator("header").getByRole("heading", { name: firstTitle })).toBeVisible();
  await expect(publicPage.getByText(`Welcome ${suffix}`)).toBeVisible();
  await publicPage.getByRole("link", { name: secondTitle }).click();
  await expect(publicPage).toHaveURL(new RegExp(`/s/${share.share.slug}/p/${second.id}$`));
  await expect(publicPage.locator("header").getByRole("heading", { name: secondTitle })).toBeVisible();
  await expect(publicPage.getByText(`Install body ${suffix}`)).toBeVisible();

  await publicPage.setViewportSize({ width: 390, height: 800 });
  await publicPage.goto(`${ORIGIN}/s/${share.share.slug}`);
  await publicPage.getByLabel("Manual page").selectOption(second.id);
  await expect(publicPage).toHaveURL(new RegExp(`/s/${share.share.slug}/p/${second.id}$`));
  await expect(publicPage.locator("header").getByRole("heading", { name: secondTitle })).toBeVisible();
  await publicPage.close();
});

test("public document share: password prompt and revoked unavailable state", async ({ page, browser }) => {
  const suffix = Date.now().toString(36);
  await login(page);
  const workspaceId = new URL(page.url()).pathname.match(/\/w\/([^/]+)/)?.[1];
  expect(workspaceId).toBeTruthy();

  const folderName = `Public Docs ${suffix}`;
  const folder = await json<{ id: string }>(await page.request.post(`${ORIGIN}/api/folders`, {
    headers: csrfHeaders,
    data: { workspaceId, parentFolderId: null, name: folderName, slug: slug(folderName) },
  }));
  const secretTitle = `Secret ${suffix}`;
  const secret = await json<{ id: string }>(await page.request.post(`${ORIGIN}/api/documents`, {
    headers: csrfHeaders,
    data: { workspaceId, folderId: folder.id, title: secretTitle, slug: slug(secretTitle), content: `# ${secretTitle}\n\nHidden body ${suffix}\n` },
  }));
  const protectedShare = await json<{ share: { slug: string } }>(await page.request.post(`${ORIGIN}/api/documents/${secret.id}/share`, {
    headers: csrfHeaders,
    data: { password: "open-sesame" },
  }));

  const publicPage = await browser.newPage();
  await publicPage.goto(`${ORIGIN}/s/${protectedShare.share.slug}`);
  await expect(publicPage.getByRole("heading", { name: "Password required" })).toBeVisible();
  await publicPage.getByLabel("Share password").fill("wrong");
  await publicPage.getByRole("button", { name: "Open share" }).click();
  await expect(publicPage.getByText("Incorrect password.")).toBeVisible();
  await publicPage.getByLabel("Share password").fill("open-sesame");
  await publicPage.getByRole("button", { name: "Open share" }).click();
  await expect(publicPage.locator("header").getByRole("heading", { name: secretTitle })).toBeVisible();
  await expect(publicPage.getByText(`Hidden body ${suffix}`)).toBeVisible();

  const revokedTitle = `Revoked ${suffix}`;
  const revoked = await json<{ id: string }>(await page.request.post(`${ORIGIN}/api/documents`, {
    headers: csrfHeaders,
    data: { workspaceId, folderId: folder.id, title: revokedTitle, slug: slug(revokedTitle), content: `# ${revokedTitle}\n` },
  }));
  const revokedShare = await json<{ share: { id: string; slug: string } }>(await page.request.post(`${ORIGIN}/api/documents/${revoked.id}/share`, { headers: csrfHeaders, data: {} }));
  await json(await page.request.delete(`${ORIGIN}/api/shares/${revokedShare.share.id}`, { headers: csrfHeaders }));

  await publicPage.goto(`${ORIGIN}/s/${revokedShare.share.slug}`);
  await expect(publicPage.getByRole("heading", { name: "Share unavailable" })).toBeVisible();
  await publicPage.close();
});
