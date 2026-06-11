import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGoogleClient, decodeIdToken } from "./google.js";

const AUD = "client-id-123";
function jwt(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const base = { iss: "https://accounts.google.com", aud: AUD, exp: Math.floor(Date.now() / 1000) + 3600 };
  return `${part({ alg: "RS256" })}.${part({ ...base, ...claims })}.signature`;
}

afterEach(() => vi.restoreAllMocks());

describe("google client", () => {
  it("decodeIdToken validates claims and reads sub/email/verified/name (lowercased email)", () => {
    const p = decodeIdToken(jwt({ sub: "123", email: "Person@Gmail.com", email_verified: true, name: "Person" }), AUD);
    expect(p).toEqual({ sub: "123", email: "person@gmail.com", emailVerified: true, name: "Person" });
  });

  it("decodeIdToken rejects a wrong audience, bad issuer, or expired token", () => {
    expect(() => decodeIdToken(jwt({ sub: "1", aud: "someone-else" }), AUD)).toThrow();
    expect(() => decodeIdToken(jwt({ sub: "1", iss: "https://evil.example" }), AUD)).toThrow();
    expect(() => decodeIdToken(jwt({ sub: "1", exp: Math.floor(Date.now() / 1000) - 3600 }), AUD)).toThrow();
  });

  it("createAuthorizationURL points at Google with the OAuth scopes + state", () => {
    const url = buildGoogleClient(AUD, "secret", "https://app/cb").createAuthorizationURL("the-state", "verifier");
    expect(url.hostname).toContain("google.com");
    expect(url.searchParams.get("state")).toBe("the-state");
    expect(url.searchParams.get("scope")).toContain("email");
  });

  it("profileFromCode exchanges the code and returns the validated id_token claims", async () => {
    const idToken = jwt({ sub: "g-1", email: "u@t.co", email_verified: true, name: "U" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "a", token_type: "Bearer", expires_in: 3600, id_token: idToken }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const profile = await buildGoogleClient(AUD, "secret", "https://app/cb").profileFromCode("code", "verifier");
    expect(profile).toEqual({ sub: "g-1", email: "u@t.co", emailVerified: true, name: "U" });
  });
});
