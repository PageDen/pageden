import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openSession, sealSession } from "./session.js";

function sign(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

describe("stateless session cookie", () => {
  it("opens a valid sealed session", () => {
    const secret = "s".repeat(32);
    const sealed = sealSession("user_123", 0, secret, 1_000);

    expect(openSession(sealed, secret, 1_000)).toEqual({ userId: "user_123", v: 0 });
  });

  it("rejects tampered or expired sessions", () => {
    const secret = "s".repeat(32);
    const sealed = sealSession("user_123", 0, secret, 1_000);

    expect(openSession(`${sealed}x`, secret, 1_000)).toBeNull();
    expect(openSession(sealed, "x".repeat(32), 1_000)).toBeNull();
    expect(openSession(sealed, secret, 1_000 + 8 * 24 * 60 * 60 * 1000)).toBeNull();
  });

  it("rejects malformed signed payloads", () => {
    const secret = "s".repeat(32);
    const body = Buffer.from("{not-json", "utf8").toString("base64url");

    expect(openSession(`${body}.${sign(body, secret)}`, secret, 1_000)).toBeNull();
  });
});
