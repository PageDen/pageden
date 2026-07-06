import { expect, test, type APIResponse, type Page, type TestInfo } from "@playwright/test";

const email = process.env.BOOTSTRAP_ADMIN_EMAIL ?? "admin@e2e.test";
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";
const ORIGIN = `http://localhost:${process.env.REAL_AGENT_E2E_WEB_PORT ?? "3000"}`;
const csrfHeaders = { origin: ORIGIN };

type CurrentWorkspace = { workspace: { id: string } };
type TokenCreate = { id: string; token: string };
type ToolResponse = { result?: { content: Array<{ type: "text"; text: string }> }; error?: { message?: string; data?: unknown } };

test.skip(process.env.RUN_REAL_AGENT_E2E !== "1", "Set RUN_REAL_AGENT_E2E=1 to run the manual real two-agent workflow.");
test.setTimeout(120_000);

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBeTruthy();
  return response.json() as Promise<T>;
}

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

async function tool<T>(page: Page, token: string, name: string, args: Record<string, unknown>): Promise<T> {
  const response = await page.request.post(`${ORIGIN}/mcp`, {
    headers: { authorization: `Bearer ${token}`, origin: ORIGIN },
    data: { jsonrpc: "2.0", id: `${name}-${Date.now()}`, method: "tools/call", params: { name, arguments: args } },
  });
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBeTruthy();
  const body = (await response.json()) as ToolResponse;
  if (body.error) throw new Error(`${name}: ${body.error.message ?? "MCP error"} ${JSON.stringify(body.error.data ?? {})}`);
  const text = body.result?.content[0]?.text;
  if (!text) throw new Error(`${name}: missing text result`);
  return JSON.parse(text) as T;
}

async function createAgentToken(page: Page, workspaceId: string, name: string): Promise<TokenCreate> {
  return json<TokenCreate>(
    await page.request.post(`${ORIGIN}/api/tokens`, {
      headers: csrfHeaders,
      data: {
        name,
        kind: "agent",
        workspaceId,
        scopes: ["search", "read", "create", "update", "append", "attachments"],
      },
    }),
  );
}

async function replaceSection(page: Page, token: string, documentId: string, version: string, anchor: string, content: string) {
  return (
    await tool<{ version: string }>(page, token, "pageden_replace_section", {
      documentId,
      anchor,
      baseVersion: version,
      allowDraft: true,
      content,
    })
  ).version;
}

test("manual real two-agent planning workflow reaches canonical accepted state", async ({ page }, testInfo: TestInfo) => {
  const suffix = Date.now().toString(36);
  await login(page);
  const { workspace } = await json<CurrentWorkspace>(
    await page.request.get(`${ORIGIN}/api/workspaces/current`, { headers: csrfHeaders }),
  );

  const agentA = await createAgentToken(page, workspace.id, `Agent A Real E2E ${suffix}`);
  const agentB = await createAgentToken(page, workspace.id, `Agent B Real E2E ${suffix}`);

  const started = await tool<{ id: string; version: string; path: string; title: string }>(
    page,
    agentA.token,
    "pageden_start_planning_workflow",
    {
      workspaceId: workspace.id,
      path: `strategy/real-two-agent-${suffix}.md`,
      title: `Real Two Agent Plan ${suffix}`,
      goal: "Verify two agent planning collaboration reaches an accepted canonical document.",
      context: "Agent A drafts and finalizes; Agent B reviews and leaves blocking comments.",
      leadAgentLabel: "Agent A Real",
      reviewAgentLabel: "Agent B Real",
      createFolders: true,
    },
  );

  let version = started.version;
  version = await replaceSection(
    page,
    agentA.token,
    started.id,
    version,
    "assumptions",
    "- Two separate agent tokens can coordinate through comments and unread signals.\n",
  );
  version = await replaceSection(
    page,
    agentA.token,
    started.id,
    version,
    "proposed-plan",
    "- Agent A drafts the plan.\n- Agent B reviews using comments only.\n- Agent A resolves blockers and finalizes through MCP.\n",
  );
  version = await replaceSection(
    page,
    agentA.token,
    started.id,
    version,
    "risks",
    "- Production readiness depends on visible comments, claims, activity, and finalization blockers.\n",
  );
  version = await replaceSection(
    page,
    agentA.token,
    started.id,
    version,
    "open-questions",
    "- RESOLVED: Should unresolved comments block finalization? Yes.\n",
  );
  version = await replaceSection(
    page,
    agentA.token,
    started.id,
    version,
    "acceptance-criteria",
    "- Agent A sees Agent B comments in unread results.\n- The web UI shows active planning state and comments.\n- The final document is canonical with workflowStatus accepted.\n",
  );
  version = await replaceSection(
    page,
    agentA.token,
    started.id,
    version,
    "final-plan",
    "Proceed with the current multi-agent planning workflow after verifying comments, unread handoff, web visibility, and finalization gates.\n",
  );

  await tool(page, agentA.token, "pageden_read_document", { documentId: started.id });
  await page.waitForTimeout(25);
  await tool(page, agentB.token, "pageden_claim_document", {
    documentId: started.id,
    ttlMinutes: 20,
    note: "Agent B reviewing the plan",
  });
  const review = await tool<{ comments: Array<{ id: string; authorTokenId: string | null }> }>(
    page,
    agentB.token,
    "pageden_review_plan",
    {
      documentId: started.id,
      baseVersion: version,
      mode: "comments_only",
      summary: "The plan is close, but the implementation notes need explicit production-readiness checks.",
      strengths: ["Clear finalization gate.", "Comments-only review path works."],
      risks: ["Confirm the web UI exposes claim and review state before finalizing."],
      blockingQuestions: ["Has Agent A verified unread handoff and dashboard visibility?"],
    },
  );
  expect(review.comments.length).toBeGreaterThanOrEqual(4);
  expect(review.comments).toEqual(expect.arrayContaining([expect.objectContaining({ authorTokenId: agentB.id })]));

  const unread = await tool<{ documents: Array<{ id: string; unreadCommentCount?: number }> }>(
    page,
    agentA.token,
    "pageden_my_unread",
    { workspaceId: workspace.id },
  );
  const unreadDoc = unread.documents.find((doc) => doc.id === started.id);
  expect(unreadDoc?.unreadCommentCount).toBeGreaterThanOrEqual(4);

  await page.goto(`/w/${workspace.id}/dashboard`);
  await expect(page.getByRole("heading", { name: "Source-of-truth health" })).toBeVisible();
  await expect(
    page.locator("main").getByRole("listitem").filter({ hasText: started.title }).filter({ hasText: "Agent B reviewing the plan" }).first(),
  ).toBeVisible();

  await page.goto(`/w/${workspace.id}/p/${started.path.replace(/\.md$/, "")}`);
  await expect(page.locator("header").getByRole("heading", { name: started.title })).toBeVisible();
  const reviewPanel = page.getByRole("heading", { name: "Planning Review" }).locator("xpath=ancestor::section[1]");
  await expect(reviewPanel.getByText("Agent B reviewing the plan")).toBeVisible();
  await expect(reviewPanel.getByText("Has Agent A verified unread handoff and dashboard visibility?")).toBeVisible();
  await expect(reviewPanel.getByText(`${review.comments.length} open comments`)).toBeVisible();
  const reviewScreenshot = testInfo.outputPath(`real-two-agent-${suffix}-review.png`);
  await page.screenshot({ path: reviewScreenshot, fullPage: true });

  const comments = await tool<{ comments: Array<{ id: string }> }>(page, agentA.token, "pageden_list_comments", {
    documentId: started.id,
  });
  for (const comment of comments.comments) {
    await tool(page, agentA.token, "pageden_resolve_comment", { commentId: comment.id });
  }
  await tool(page, agentB.token, "pageden_release_document", { documentId: started.id });
  const latest = await tool<{ version: string }>(page, agentA.token, "pageden_read_document", { documentId: started.id });
  const finalized = await tool<{ status: string; workflowStatus: string; decision: { id: string; status: string } }>(
    page,
    agentA.token,
    "pageden_finalize_plan",
    {
      documentId: started.id,
      baseVersion: latest.version,
      owner: "Agent A Real",
    },
  );
  expect(finalized).toMatchObject({
    status: "canonical",
    workflowStatus: "accepted",
    decision: { id: "final-plan", status: "accepted" },
  });

  await page.reload();
  await expect(reviewPanel.getByText("Canonical plan is accepted.")).toBeVisible();
  await expect(reviewPanel.getByText("No open review comments.")).toBeVisible();
  const finalScreenshot = testInfo.outputPath(`real-two-agent-${suffix}-final.png`);
  await page.screenshot({ path: finalScreenshot, fullPage: true });

  console.log(
    JSON.stringify(
      {
        workspaceId: workspace.id,
        documentId: started.id,
        path: started.path,
        title: started.title,
        unreadCommentCount: unreadDoc?.unreadCommentCount ?? null,
        screenshots: [reviewScreenshot, finalScreenshot],
      },
      null,
      2,
    ),
  );
});
