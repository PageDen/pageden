import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { getApp, closeApp, req, bearer, sessionFor } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario, createUser, addMember, grant } from "../fixtures/seed.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

async function makeDoc(cookies: Record<string, string>, workspaceId: string, folderId: string, slug: string, title: string, content: string) {
  const res = await req({
    method: "POST",
    url: "/api/documents",
    cookies,
    payload: { workspaceId, folderId, title, slug, content },
  });
  if (res.statusCode !== 201) throw new Error(`create doc failed: ${res.body}`);
  return { id: res.json().id as string, version: res.json().version as string };
}

describe("GET /api/documents/:id/related-docs", () => {
  it("returns the typed relationship lists (supersedes, references, backlinks, prLinks)", async () => {
    const s = await baseScenario();
    // Three docs: A is the focus; B links to A via wikilink; A's frontmatter
    // declares it supersedes C and lists a PR.
    const a = await makeDoc(
      s.adminCookie,
      s.ws.id,
      s.folderId,
      "alpha",
      "Alpha",
      `---\nprLinks: [https://github.com/PageDen/pageden/pull/42]\n---\n\n# Alpha\n\nSee [[engineering/beta]] for the follow-up.\n`,
    );
    await makeDoc(
      s.adminCookie,
      s.ws.id,
      s.folderId,
      "beta",
      "Beta",
      `# Beta\n\nA link back to [[engineering/alpha]] so backlinks can find it.\n`,
    );
    const c = await makeDoc(
      s.adminCookie,
      s.ws.id,
      s.folderId,
      "gamma",
      "Gamma",
      `---\nstatus: superseded\nsupersededBy: engineering/alpha\n---\n\n# Gamma\n`,
    );

    const res = await req({ method: "GET", url: `/api/documents/${a.id}/related-docs`, cookies: s.adminCookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.documentId).toBe(a.id);
    expect(body.workspaceId).toBe(s.ws.id);

    // C declares supersededBy: alpha, so alpha "supersedes" gamma.
    expect(body.supersedes.map((d: { id: string }) => d.id)).toEqual([c.id]);
    expect(body.supersededBy).toBeNull();

    // Alpha's body has `[[engineering/beta]]` → references should include Beta.
    expect(body.references.length).toBe(1);
    expect(body.references[0].path).toContain("beta");

    // Beta links back to alpha → backlinks should include Beta.
    expect(body.referencedBy.length).toBe(1);
    expect(body.referencedBy[0].path).toContain("beta");

    // PR link parsed from frontmatter.
    expect(body.prLinks).toEqual(["https://github.com/PageDen/pageden/pull/42"]);
  });

  it("treats frontmatter relatedDocs wikilinks as document references", async () => {
    const s = await baseScenario();
    const focus = await makeDoc(
      s.adminCookie,
      s.ws.id,
      s.folderId,
      "share-dialog-ux-redesign",
      "Share Dialog UX Redesign",
      `---
status: canonical
relatedDocs:
  - "[[permission-model-review-outline-docmost]]"
  - "[[ai-agent-workspace-improvements]]"
---

# Share Dialog UX Redesign
`,
    );
    await makeDoc(
      s.adminCookie,
      s.ws.id,
      s.folderId,
      "permission-model-review-outline-docmost",
      "Permission Model Review vs Outline & Docmost",
      "# Permission Model Review\n",
    );
    await makeDoc(
      s.adminCookie,
      s.ws.id,
      s.folderId,
      "ai-agent-workspace-improvements",
      "AI Agent Workspace Improvements",
      "# AI Agent Workspace Improvements\n",
    );

    const res = await req({ method: "GET", url: `/api/documents/${focus.id}/related-docs`, cookies: s.adminCookie });
    expect(res.statusCode).toBe(200);
    const paths = res.json().references.map((doc: { path: string }) => doc.path).sort();
    expect(paths).toEqual([
      "engineering/ai-agent-workspace-improvements.md",
      "engineering/permission-model-review-outline-docmost.md",
    ]);
  });

  it("excludes related documents the caller cannot read", async () => {
    const s = await baseScenario();
    // Public folder (s.folderId) holds the focus document.
    const focus = await makeDoc(
      s.adminCookie,
      s.ws.id,
      s.folderId,
      "focus",
      "Focus",
      `# Focus\n\nReferences [[private/secret]].\n`,
    );
    // Private folder with a secret doc that links back to focus.
    const privateFolderRes = await req({
      method: "POST",
      url: "/api/folders",
      cookies: s.adminCookie,
      payload: { workspaceId: s.ws.id, name: "Private", slug: "private" },
    });
    expect(privateFolderRes.statusCode).toBe(201);
    const privateFolderId = privateFolderRes.json().id as string;
    await makeDoc(
      s.adminCookie,
      s.ws.id,
      privateFolderId,
      "secret",
      "Secret",
      `# Secret\n\nLinks back to [[engineering/focus]].\n`,
    );

    // Member user only sees the public folder.
    const member = await createUser("member@t.co");
    await addMember(s.ws.id, member.id, "guest");
    await grant(s.ws.id, "user", member.id, "folder", s.folderId, "viewer");
    const cookie = sessionFor(member.id);

    const res = await req({ method: "GET", url: `/api/documents/${focus.id}/related-docs`, cookies: cookie });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // The secret doc is hidden from the member; references AND referencedBy
    // must both omit it.
    expect(body.references).toHaveLength(0);
    expect(body.referencedBy).toHaveLength(0);
  });

  it("returns 404 when the caller cannot read the document itself", async () => {
    const s = await baseScenario();
    const focus = await makeDoc(s.adminCookie, s.ws.id, s.folderId, "focus", "Focus", "# Focus\n");
    const stranger = await createUser("stranger@t.co");
    const cookie = sessionFor(stranger.id);
    const res = await req({ method: "GET", url: `/api/documents/${focus.id}/related-docs`, cookies: cookie });
    expect(res.statusCode).toBe(404);
  });

  it("works through the MCP tool pageden_document_relationships", async () => {
    const s = await baseScenario();
    const tokenRes = await req({
      method: "POST",
      url: "/api/tokens",
      cookies: s.adminCookie,
      payload: { name: "Relations agent", kind: "agent", workspaceId: s.ws.id, scopes: ["search", "read", "create"] },
    });
    expect(tokenRes.statusCode).toBe(201);
    const token = tokenRes.json().token as string;
    const focus = await makeDoc(s.adminCookie, s.ws.id, s.folderId, "alpha", "Alpha", "# Alpha\n\nSee [[engineering/runbook]].\n");

    const res = await req({
      method: "POST",
      url: "/mcp",
      headers: bearer(token),
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "pageden_document_relationships", arguments: { documentId: focus.id } },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.json().result.content[0].text);
    expect(body.documentId).toBe(focus.id);
    // baseScenario's seed creates an "engineering/runbook" doc.
    expect(body.references.length).toBe(1);
    expect(body.references[0].path).toContain("runbook");
  });
});
