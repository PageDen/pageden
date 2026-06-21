import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeApp, getApp, req } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { baseScenario } from "../fixtures/seed.js";

// Smallest valid 1x1 PNG.
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082",
  "hex",
);

beforeAll(async () => {
  await getApp();
});
afterAll(async () => {
  await closeApp();
  await prisma.$disconnect();
});
beforeEach(async () => {
  process.env.CLOUD_HOSTED = "true";
  await resetDb();
});
afterEach(() => {
  delete process.env.CLOUD_HOSTED;
});

describe("workspace logo", () => {
  it("uploads, serves, sanitizes SVG, and deletes (cloud-only)", async () => {
    const s = await baseScenario();

    // Cloud-only: upload is 404 on self-hosted.
    delete process.env.CLOUD_HOSTED;
    const off = await req({
      method: "POST",
      url: `/api/workspaces/${s.ws.id}/logo`,
      cookies: s.adminCookie,
      headers: { "content-type": "image/png" },
      payload: PNG,
    });
    expect(off.statusCode).toBe(404);
    process.env.CLOUD_HOSTED = "true";

    // Reject disallowed content types.
    const badType = await req({
      method: "POST",
      url: `/api/workspaces/${s.ws.id}/logo`,
      cookies: s.adminCookie,
      headers: { "content-type": "text/plain" },
      payload: Buffer.from("nope"),
    });
    expect(badType.statusCode).toBe(400);

    // Upload a PNG.
    const up = await req({
      method: "POST",
      url: `/api/workspaces/${s.ws.id}/logo`,
      cookies: s.adminCookie,
      headers: { "content-type": "image/png" },
      payload: PNG,
    });
    expect(up.statusCode).toBe(200);
    expect(up.json().logoUrl).toContain(`/api/workspaces/${s.ws.id}/logo`);

    // logoUrl surfaces on /me.
    const me = await req({ method: "GET", url: "/api/me", cookies: s.adminCookie });
    const meWs = me.json().workspaces.find((w: { id: string; logoUrl: string | null }) => w.id === s.ws.id);
    expect(meWs?.logoUrl).toBeTruthy();

    // Public serve (no auth) returns the bytes with safe headers.
    const served = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/logo` });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("image/png");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");

    // SVG is sanitized on upload, including malformed script endings and event handlers.
    const maliciousSvg = `
      <svg xmlns="http://www.w3.org/2000/svg">
        <script>alert(1)</script>
        <script>alert(2)</script\t\n bar>
        <script src="https://evil.example/x.js" />
        <foreignObject><div onclick="alert(3)">x</div></foreignObject>
        <rect onload="alert(4)" style="background:url(javascript:alert(5))" href="java\nscript:alert(6)" xlink:href="#ok" width="1" />
      </svg>`;
    const upSvg = await req({
      method: "POST",
      url: `/api/workspaces/${s.ws.id}/logo`,
      cookies: s.adminCookie,
      headers: { "content-type": "image/svg+xml" },
      payload: Buffer.from(maliciousSvg),
    });
    expect(upSvg.statusCode).toBe(200);
    const servedSvg = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/logo` });
    expect(servedSvg.body).not.toMatch(/<\s*script/i);
    expect(servedSvg.body).not.toMatch(/<\s*foreignObject/i);
    expect(servedSvg.body).not.toContain("onclick");
    expect(servedSvg.body).not.toContain("onload");
    expect(servedSvg.body).not.toContain("javascript:");
    expect(servedSvg.body).toContain('xlink:href="#ok"');

    // Delete clears it.
    const del = await req({ method: "DELETE", url: `/api/workspaces/${s.ws.id}/logo`, cookies: s.adminCookie });
    expect(del.statusCode).toBe(200);
    const gone = await req({ method: "GET", url: `/api/workspaces/${s.ws.id}/logo` });
    expect(gone.statusCode).toBe(404);
  });

  it("rejects logo upload from non-admins", async () => {
    const s = await baseScenario();
    const outsider = await req({
      method: "POST",
      url: `/api/workspaces/${s.ws.id}/logo`,
      headers: { "content-type": "image/png" },
      payload: PNG,
    });
    expect([401, 404]).toContain(outsider.statusCode);
  });
});
