import { expect, test, type Page } from "@playwright/test";

const email = process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";
const ORIGIN = "http://localhost:3000";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
}

test("agents: standing key config authenticates the MCP probe without OAuth", async ({ page }) => {
  await login(page);

  const workspaceId = new URL(page.url()).pathname.match(/\/w\/([^/]+)/)?.[1];
  expect(workspaceId).toBeTruthy();

  await page.goto(`/w/${workspaceId}/agents`);
  await expect(page.getByRole("heading", { name: /Connect Codex, Claude, Hermes/ })).toBeVisible();

  await page.getByLabel("Name").fill(`Codex e2e ${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "Create agent key" }).click();
  await expect(page.getByText("Copy this token now")).toBeVisible();

  const token = await page
    .getByText("Copy this token now")
    .locator("xpath=ancestor::div[contains(@class, 'rounded-lg')][1]")
    .locator("code")
    .textContent();
  expect(token).toBeTruthy();

  const codexConfig = page.locator("pre code", { hasText: "[mcp_servers.pageden]" });
  await expect(codexConfig).toContainText("@pageden/mcp");
  await expect(codexConfig).toContainText("PAGEDEN_TOKEN = \"pm_");
  await expect(codexConfig).toContainText(`PAGEDEN_WORKSPACE = "${workspaceId}"`);

  const authenticatedProbe = await page.evaluate(
    async ({ origin, token }) => {
      const res = await fetch(`${origin}/mcp`, {
        headers: { authorization: `Bearer ${token}` },
        credentials: "omit",
      });
      return {
        status: res.status,
        wwwAuthenticate: res.headers.get("www-authenticate"),
        body: await res.json(),
      };
    },
    { origin: ORIGIN, token },
  );
  expect(authenticatedProbe.status).toBe(200);
  expect(authenticatedProbe.wwwAuthenticate).toBeNull();
  expect(authenticatedProbe.body).toMatchObject({
    ok: true,
    transport: "streamable-http",
    authType: "token",
    tokenWorkspaceId: workspaceId,
  });

  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText(/Connection works/)).toBeVisible();
});
