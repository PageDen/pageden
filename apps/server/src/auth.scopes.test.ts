import { describe, expect, it } from "vitest";
import { requireTokenScope, type AuthContext } from "./auth.js";

describe("token scopes", () => {
  it("allows session auth for all scopes", () => {
    expect(() => requireTokenScope({ userId: "u1", authType: "session" }, "update")).not.toThrow();
  });

  it("allows token auth when the token has the requested scope", () => {
    const auth: AuthContext = { userId: "u1", authType: "token", tokenScopes: ["read", "search"] };
    expect(() => requireTokenScope(auth, "read")).not.toThrow();
  });

  it("rejects token auth when the token is missing the requested scope", () => {
    const auth: AuthContext = { userId: "u1", authType: "token", tokenScopes: ["read"] };
    expect(() => requireTokenScope(auth, "update")).toThrow(/forbidden/i);
  });
});
