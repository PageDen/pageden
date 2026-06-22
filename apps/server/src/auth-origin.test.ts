import { describe, expect, it } from "vitest";
import { isTrustedWebOrigin, resolveReturnOrigin, sharedCookieDomain, type AuthOriginEnv } from "./auth-origin.js";

const cloud: AuthOriginEnv = { webOrigin: "https://go.pageden.io", baseDomain: "pageden.io", cloudHosted: true };
const selfHost: AuthOriginEnv = { webOrigin: "http://localhost:3000", baseDomain: undefined, cloudHosted: false };

describe("sharedCookieDomain", () => {
  it("scopes to the parent base domain on cloud", () => {
    expect(sharedCookieDomain(cloud)).toBe(".pageden.io");
    expect(sharedCookieDomain({ ...cloud, baseDomain: "PageDen.IO" })).toBe(".pageden.io");
  });
  it("is undefined off-cloud or without a base domain", () => {
    expect(sharedCookieDomain(selfHost)).toBeUndefined();
    expect(sharedCookieDomain({ ...cloud, baseDomain: undefined })).toBeUndefined();
    expect(sharedCookieDomain({ ...cloud, cloudHosted: false })).toBeUndefined();
  });
});

describe("resolveReturnOrigin", () => {
  it("returns a real workspace subdomain origin", () => {
    expect(resolveReturnOrigin("livro.pageden.io", cloud)).toBe("https://livro.pageden.io");
    expect(resolveReturnOrigin("ACME.pageden.io", cloud)).toBe("https://acme.pageden.io");
  });
  it("falls back to the apex for the base/apex host", () => {
    expect(resolveReturnOrigin("go.pageden.io", cloud)).toBe("https://go.pageden.io");
    expect(resolveReturnOrigin("pageden.io", cloud)).toBe("https://go.pageden.io");
  });
  it("rejects foreign, nested, reserved, and empty hosts (no open redirect)", () => {
    expect(resolveReturnOrigin("evil.com", cloud)).toBe("https://go.pageden.io");
    expect(resolveReturnOrigin("livro.pageden.io.evil.com", cloud)).toBe("https://go.pageden.io");
    expect(resolveReturnOrigin("a.b.pageden.io", cloud)).toBe("https://go.pageden.io");
    expect(resolveReturnOrigin("api.pageden.io", cloud)).toBe("https://go.pageden.io"); // reserved
    expect(resolveReturnOrigin("", cloud)).toBe("https://go.pageden.io");
    expect(resolveReturnOrigin(undefined, cloud)).toBe("https://go.pageden.io");
  });
  it("preserves scheme and never upgrades off-cloud", () => {
    expect(resolveReturnOrigin("anything.localhost", selfHost)).toBe("http://localhost:3000");
  });
});

describe("isTrustedWebOrigin", () => {
  it("trusts the apex and real workspace subdomains", () => {
    expect(isTrustedWebOrigin("https://go.pageden.io", cloud)).toBe(true);
    expect(isTrustedWebOrigin("https://livro.pageden.io", cloud)).toBe(true);
  });
  it("rejects foreign, reserved, nested, malformed, and empty origins", () => {
    expect(isTrustedWebOrigin("https://evil.com", cloud)).toBe(false);
    expect(isTrustedWebOrigin("https://api.pageden.io", cloud)).toBe(false);
    expect(isTrustedWebOrigin("https://a.b.pageden.io", cloud)).toBe(false);
    expect(isTrustedWebOrigin("https://livro.pageden.io.evil.com", cloud)).toBe(false);
    expect(isTrustedWebOrigin("not a url", cloud)).toBe(false);
    expect(isTrustedWebOrigin(null, cloud)).toBe(false);
    expect(isTrustedWebOrigin(undefined, cloud)).toBe(false);
  });
  it("off-cloud trusts only the configured origin", () => {
    expect(isTrustedWebOrigin("http://localhost:3000", selfHost)).toBe(true);
    expect(isTrustedWebOrigin("https://anything.pageden.io", selfHost)).toBe(false);
  });
});
