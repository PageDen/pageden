import { expect, test, type APIResponse, type Page } from "@playwright/test";

const email = process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";
const ORIGIN = "http://localhost:3000";
const csrfHeaders = { origin: ORIGIN };

type Folder = { id: string };
type DocumentCreate = { id: string; version: string; path: string };
type CommentCreate = { comment: { id: string } };
type CurrentWorkspace = { workspace: { id: string } };

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

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<T>;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function workspaceId(page: Page): Promise<string> {
  const current = await json<CurrentWorkspace>(await page.request.get(`${ORIGIN}/api/workspaces/current`, { headers: csrfHeaders }));
  return current.workspace.id;
}

async function createPlanningDocument(page: Page, workspaceId: string, suffix: string, titlePrefix: string): Promise<{
  folderSlug: string;
  docSlug: string;
  title: string;
  doc: DocumentCreate;
}> {
  const folderName = `Planning E2E ${suffix}`;
  const folderSlug = slug(folderName);
  const folder = await json<Folder>(await page.request.post(`${ORIGIN}/api/folders`, {
    headers: csrfHeaders,
    data: { workspaceId, parentFolderId: null, name: folderName, slug: folderSlug },
  }));
  const title = `${titlePrefix} ${suffix}`;
  const docSlug = slug(title);
  const doc = await json<DocumentCreate>(await page.request.post(`${ORIGIN}/api/documents`, {
    headers: csrfHeaders,
    data: {
      workspaceId,
      folderId: folder.id,
      title,
      slug: docSlug,
      content: planningContent(title),
    },
  }));
  return { folderSlug, docSlug, title, doc };
}

function planningContent(title: string) {
  return [
    "---",
    "status: draft",
    "workflow: multi-agent-planning",
    "workflowStatus: final-review",
    "reviewRound: 2",
    "leadAgent: Agent A",
    "reviewAgent: Agent B",
    "---",
    "",
    `# ${title}`,
    "",
    "## Assumptions",
    "",
    "- Agents coordinate through inline comments and workflow metadata.",
    "",
    "## Proposed Plan",
    "",
    "- Build the plan, review it, and finalize only after blockers clear.",
    "",
    "## Risks",
    "",
    "- Browser promotion must not bypass unresolved comments.",
    "",
    "## Final Plan",
    "",
    "- Use the safe planning finalizer from the web UI.",
    "",
    "## Acceptance Criteria",
    "",
    "- The Planning Review panel displays open comments.",
    "- The finalizer refuses blockers and then promotes the accepted plan.",
    "",
    "## Decisions",
    "",
    ":::decision",
    "id: final-plan",
    "status: accepted",
    "owner: Agent A",
    "decision: Use the safe planning finalizer from the web UI.",
    "reason: MCP and browser finalization must enforce the same gates.",
    ":::",
  ].join("\n");
}

test("planning review: dashboard visibility, blocker display, and safe web finalization", async ({ page }) => {
  const suffix = Date.now().toString(36);
  await login(page);
  const wsId = await workspaceId(page);
  const seeded = await createPlanningDocument(page, wsId, suffix, "Browser Planning");

  const comment = await json<CommentCreate>(await page.request.post(`${ORIGIN}/api/documents/${seeded.doc.id}/comments`, {
    headers: csrfHeaders,
    data: { sectionAnchor: "risks", body: "Confirm unresolved comments block promotion." },
  }));

  await page.goto(`/w/${wsId}/dashboard`);
  await expect(page.getByRole("heading", { name: "Source-of-truth health" })).toBeVisible();
  const activePlan = page
    .locator("main")
    .getByRole("listitem")
    .filter({ hasText: seeded.title })
    .filter({ hasText: "Final Review" })
    .first();
  await expect(activePlan.getByRole("link", { name: seeded.title })).toBeVisible();
  await expect(activePlan.getByText("1 open")).toBeVisible();

  await page.goto(`/w/${wsId}/p/${seeded.folderSlug}/${seeded.docSlug}`);
  await expect(page.locator("header").getByRole("heading", { name: seeded.title })).toBeVisible();
  const reviewPanel = page.getByRole("heading", { name: "Planning Review" }).locator("xpath=ancestor::section[1]");
  await expect(reviewPanel).toBeVisible();
  await expect(reviewPanel.getByText("Final review")).toBeVisible();
  await expect(reviewPanel.getByText("Agent A")).toBeVisible();
  await expect(reviewPanel.getByText("Agent B")).toBeVisible();
  await expect(reviewPanel.getByText("#risks")).toBeVisible();
  await expect(reviewPanel.getByText("Confirm unresolved comments block promotion.")).toBeVisible();
  await expect(reviewPanel.getByText("1 open comment")).toBeVisible();
  await expect(reviewPanel.getByText("Not ready to finalize yet.")).toBeVisible();
  await expect(reviewPanel.getByRole("button", { name: "Mark canonical" })).toBeDisabled();

  await json(await page.request.post(`${ORIGIN}/api/comments/${comment.comment.id}/resolve`, { headers: csrfHeaders }));
  await page.reload();
  await expect(reviewPanel.getByText("Not ready to finalize yet.")).toBeVisible();
  await reviewPanel.getByRole("button", { name: "Accept plan" }).click();
  await expect(reviewPanel.getByText("Ready for canonical promotion.")).toBeVisible();
  await expect(reviewPanel.getByRole("button", { name: "Mark canonical" })).toBeEnabled();

  const finalized = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    response.url().includes(`/api/documents/${seeded.doc.id}/finalize-plan`) &&
    response.ok(),
  );
  await reviewPanel.getByRole("button", { name: "Mark canonical" }).click();
  await finalized;
  await expect(reviewPanel.getByText("Canonical plan is accepted.")).toBeVisible();
  await expect(reviewPanel.getByRole("button", { name: "Mark canonical" })).toHaveCount(0);
});
