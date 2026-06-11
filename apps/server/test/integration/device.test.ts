import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { getApp, closeApp, req, bearer } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { createUser, createWorkspace, addMember, member } from "../fixtures/seed.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });

async function start() {
  const res = await req({ method: "POST", url: "/api/auth/device/start" });
  expect(res.statusCode).toBe(201);
  return res.json() as { deviceCode: string; userCode: string; verificationUri: string };
}

describe("device-code login", () => {
  it("full flow: start → pending → approve → token issued once → consumed", async () => {
    const ws = await createWorkspace();
    const u = await createUser("dev@t.co");
    await addMember(ws.id, u.id, "member");
    const cookie = (await member(ws.id, "ignore@t.co")).cookie; // unused; we use u's session below
    void cookie;

    const started = await start();
    expect(started.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(started.verificationUri).toContain("/devices");

    // before approval → pending
    const pending = await req({ method: "POST", url: "/api/auth/device/poll", payload: { deviceCode: started.deviceCode } });
    expect(pending.json().status).toBe("pending");

    // user approves via the web (cookie auth)
    const { sessionFor } = await import("../helpers/app.js");
    const approve = await req({ method: "POST", url: "/api/auth/device/approve", cookies: sessionFor(u.id), payload: { userCode: started.userCode, action: "approve" } });
    expect(approve.statusCode).toBe(200);

    // plugin polls → approved + token (once)
    const ok = await req({ method: "POST", url: "/api/auth/device/poll", payload: { deviceCode: started.deviceCode } });
    expect(ok.json().status).toBe("approved");
    const token = ok.json().token as string;
    expect(token.startsWith("pm_live_")).toBe(true);

    // the token authenticates as the approving user
    const me = await req({ method: "GET", url: "/api/me", headers: bearer(token) });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(u.id);

    // polling again → consumed (token issued only once)
    const again = await req({ method: "POST", url: "/api/auth/device/poll", payload: { deviceCode: started.deviceCode } });
    expect(again.json().status).toBe("consumed");
  });

  it("deny → poll returns denied, no token", async () => {
    const ws = await createWorkspace("B", "b");
    const u = await createUser("deny@t.co");
    await addMember(ws.id, u.id, "member");
    const { sessionFor } = await import("../helpers/app.js");
    const started = await start();
    await req({ method: "POST", url: "/api/auth/device/approve", cookies: sessionFor(u.id), payload: { userCode: started.userCode, action: "deny" } });
    const res = await req({ method: "POST", url: "/api/auth/device/poll", payload: { deviceCode: started.deviceCode } });
    expect(res.json().status).toBe("denied");
  });

  it("expired request → poll expired, approve 404", async () => {
    const ws = await createWorkspace("C", "c");
    const u = await createUser("exp@t.co");
    await addMember(ws.id, u.id, "member");
    const { sessionFor } = await import("../helpers/app.js");
    const started = await start();
    await prisma.deviceAuthRequest.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await req({ method: "POST", url: "/api/auth/device/poll", payload: { deviceCode: started.deviceCode } })).json().status).toBe("expired");
    const approve = await req({ method: "POST", url: "/api/auth/device/approve", cookies: sessionFor(u.id), payload: { userCode: started.userCode, action: "approve" } });
    expect(approve.statusCode).toBe(404);
  });

  it("unknown code → poll expired, approve 404", async () => {
    const m = await member(await (await createWorkspace("D", "d")).id, "x@t.co");
    expect((await req({ method: "POST", url: "/api/auth/device/poll", payload: { deviceCode: "pm_live_nope" } })).json().status).toBe("expired");
    const approve = await req({ method: "POST", url: "/api/auth/device/approve", cookies: m.cookie, payload: { userCode: "ZZZZ-ZZZZ", action: "approve" } });
    expect(approve.statusCode).toBe(404);
  });

  it("CSRF: device/start is exempt (no Origin needed); approve requires Origin", async () => {
    const app = await getApp();
    // plugin call, no Origin header — allowed
    const s = await app.inject({ method: "POST", url: "/api/auth/device/start" });
    expect(s.statusCode).toBe(201);
    // cookie-authed approve with a foreign Origin → blocked by CSRF guard
    const ws = await createWorkspace("E", "e");
    const u = await createUser("csrf@t.co");
    await addMember(ws.id, u.id, "member");
    const { sessionFor } = await import("../helpers/app.js");
    const bad = await app.inject({ method: "POST", url: "/api/auth/device/approve", headers: { origin: "https://evil.example" }, cookies: sessionFor(u.id), payload: { userCode: "ABCD-1234", action: "approve" } });
    expect(bad.statusCode).toBe(403);
  });

  it("concurrent polls after approval mint exactly one token", async () => {
    const ws = await createWorkspace("F", "f");
    const u = await createUser("conc@t.co");
    await addMember(ws.id, u.id, "member");
    const { sessionFor } = await import("../helpers/app.js");
    const started = await start();
    await req({ method: "POST", url: "/api/auth/device/approve", cookies: sessionFor(u.id), payload: { userCode: started.userCode, action: "approve" } });
    const [a, b] = await Promise.all([
      req({ method: "POST", url: "/api/auth/device/poll", payload: { deviceCode: started.deviceCode } }),
      req({ method: "POST", url: "/api/auth/device/poll", payload: { deviceCode: started.deviceCode } }),
    ]);
    const statuses = [a.json().status, b.json().status].sort();
    expect(statuses).toEqual(["approved", "consumed"]);
    const tokens = await prisma.apiToken.count({ where: { userId: u.id, name: "Obsidian (device login)" } });
    expect(tokens).toBe(1);
  });

  it("concurrent approve + deny is atomic — one wins, one 404", async () => {
    const ws = await createWorkspace("G", "g");
    const u1 = await createUser("a1@t.co");
    const u2 = await createUser("a2@t.co");
    await addMember(ws.id, u1.id, "member");
    await addMember(ws.id, u2.id, "member");
    const { sessionFor } = await import("../helpers/app.js");
    const started = await start();
    const [r1, r2] = await Promise.all([
      req({ method: "POST", url: "/api/auth/device/approve", cookies: sessionFor(u1.id), payload: { userCode: started.userCode, action: "approve" } }),
      req({ method: "POST", url: "/api/auth/device/approve", cookies: sessionFor(u2.id), payload: { userCode: started.userCode, action: "deny" } }),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 404]);
  });

  it("lookup shows origin/age for the signed-in user; 404 unknown; 401 anon", async () => {
    const ws = await createWorkspace("H", "h");
    const u = await createUser("look@t.co");
    await addMember(ws.id, u.id, "member");
    const { sessionFor } = await import("../helpers/app.js");
    const started = await start();
    const ok = await req({ method: "GET", url: `/api/auth/device/lookup?userCode=${encodeURIComponent(started.userCode)}`, cookies: sessionFor(u.id) });
    expect(ok.statusCode).toBe(200);
    expect(typeof ok.json().createdAt).toBe("string");
    const unknown = await req({ method: "GET", url: "/api/auth/device/lookup?userCode=ZZZZ-ZZZZ", cookies: sessionFor(u.id) });
    expect(unknown.statusCode).toBe(404);
    const anon = await req({ method: "GET", url: `/api/auth/device/lookup?userCode=${encodeURIComponent(started.userCode)}` });
    expect(anon.statusCode).toBe(401);
  });
});
