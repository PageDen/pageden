import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import { getApp, closeApp, req } from "../helpers/app.js";
import { prisma, resetDb } from "../helpers/db.js";
import { createUser } from "../fixtures/seed.js";
import { setGoogleClient, type GoogleProfile } from "../../src/google.js";

beforeAll(async () => { await getApp(); });
afterAll(async () => { await closeApp(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDb(); });
afterEach(() => setGoogleClient(null));

let nextProfile: GoogleProfile;
function useGoogle() {
  setGoogleClient({
    createAuthorizationURL(state, verifier) {
      return new URL(`https://accounts.google.test/auth?state=${state}&v=${verifier}`);
    },
    async profileFromCode() {
      return nextProfile;
    },
  });
}

async function googleCallback(profile: GoogleProfile) {
  nextProfile = profile;
  const start = await req({ method: "GET", url: "/api/auth/google/start" });
  const state = start.cookies.find((c) => c.name === "pm_oauth_state")!.value;
  const verifier = start.cookies.find((c) => c.name === "pm_oauth_verifier")!.value;
  return req({
    method: "GET",
    url: `/api/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
    cookies: { pm_oauth_state: state, pm_oauth_verifier: verifier },
  });
}

const profile = (over: Partial<GoogleProfile> = {}): GoogleProfile => ({
  sub: "google-sub-1",
  email: "person@gmail.com",
  emailVerified: true,
  name: "Person",
  ...over,
});

describe("google oauth", () => {
  it("reports config and 404s the routes when not configured", async () => {
    setGoogleClient(null);
    expect((await req({ method: "GET", url: "/api/auth/config" })).json()).toEqual({ googleEnabled: false, captcha: null });
    expect((await req({ method: "GET", url: "/api/auth/google/start" })).statusCode).toBe(404);
  });

  it("start sets state + verifier cookies and redirects to Google", async () => {
    useGoogle();
    expect((await req({ method: "GET", url: "/api/auth/config" })).json()).toEqual({ googleEnabled: true, captcha: null });
    const start = await req({ method: "GET", url: "/api/auth/google/start" });
    expect(start.statusCode).toBe(302);
    expect(start.headers.location).toContain("accounts.google.test");
    expect(start.cookies.find((c) => c.name === "pm_oauth_state")).toBeTruthy();
    expect(start.cookies.find((c) => c.name === "pm_oauth_verifier")).toBeTruthy();
  });

  it("first sign-in creates a user + their workspace and logs them in", async () => {
    useGoogle();
    const cb = await googleCallback(profile());
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toContain("localhost:3000"); // back to the web origin, not user input
    expect(cb.cookies.find((c) => c.name === "pm_session")).toBeTruthy();
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: "person@gmail.com" },
      select: { id: true, passwordHash: true, emailVerified: true, workspaceMemberships: { select: { role: true } }, oauthAccounts: { select: { provider: true } } },
    });
    expect(user.passwordHash).toBeNull();
    expect(user.emailVerified).toBe(true);
    expect(user.workspaceMemberships).toEqual([{ role: "admin" }]);
    expect(user.oauthAccounts).toEqual([{ provider: "google" }]);
  });

  it("an already-linked account signs in the same user (no duplicate)", async () => {
    useGoogle();
    await googleCallback(profile());
    const first = await prisma.user.findUniqueOrThrow({ where: { email: "person@gmail.com" }, select: { id: true } });
    await googleCallback(profile());
    const count = await prisma.user.count({ where: { email: "person@gmail.com" } });
    expect(count).toBe(1);
    const link = await prisma.oAuthAccount.findUnique({ where: { provider_providerAccountId: { provider: "google", providerAccountId: "google-sub-1" } }, select: { userId: true } });
    expect(link?.userId).toBe(first.id);
  });

  it("links Google to an existing account when the email is verified", async () => {
    useGoogle();
    const existing = await createUser("person@gmail.com", "Person"); // password account, emailVerified default false
    const cb = await googleCallback(profile({ sub: "google-sub-2" }));
    expect(cb.statusCode).toBe(302);
    const link = await prisma.oAuthAccount.findUnique({ where: { provider_providerAccountId: { provider: "google", providerAccountId: "google-sub-2" } }, select: { userId: true } });
    expect(link?.userId).toBe(existing.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: existing.id }, select: { emailVerified: true } })).emailVerified).toBe(true);
  });

  it("does NOT link to an existing account when Google's email is unverified", async () => {
    useGoogle();
    await createUser("person@gmail.com", "Person");
    const cb = await googleCallback(profile({ sub: "google-sub-3", emailVerified: false }));
    expect(cb.headers.location).toContain("/login?error=google");
    expect(await prisma.oAuthAccount.count()).toBe(0);
  });

  it("does not create a new account via Google when self-signup is disabled", async () => {
    useGoogle();
    const prev = process.env.AUTH_ALLOW_SIGNUP;
    process.env.AUTH_ALLOW_SIGNUP = "false";
    try {
      const cb = await googleCallback(profile({ sub: "blocked-sub", email: "blocked@gmail.com" }));
      expect(cb.headers.location).toContain("/login?error=google");
      expect(await prisma.user.count({ where: { email: "blocked@gmail.com" } })).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.AUTH_ALLOW_SIGNUP;
      else process.env.AUTH_ALLOW_SIGNUP = prev;
    }
  });

  it("rejects a callback with a mismatched state", async () => {
    useGoogle();
    nextProfile = profile();
    const start = await req({ method: "GET", url: "/api/auth/google/start" });
    const verifier = start.cookies.find((c) => c.name === "pm_oauth_verifier")!.value;
    const cb = await req({
      method: "GET",
      url: "/api/auth/google/callback?code=abc&state=WRONG",
      cookies: { pm_oauth_state: "DIFFERENT", pm_oauth_verifier: verifier },
    });
    expect(cb.headers.location).toContain("/login?error=google");
  });
});
