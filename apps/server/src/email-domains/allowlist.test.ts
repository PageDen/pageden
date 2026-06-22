import { describe, expect, it } from "vitest";
import {
  InvalidDomainError,
  domainMatchesAllowlist,
  emailDomain,
  normalizeDomain,
  normalizeDomains,
} from "./allowlist.js";

describe("normalizeDomain", () => {
  it("lowercases and trims", () => {
    expect(normalizeDomain("  Example.COM ")).toBe("example.com");
  });
  it("strips a trailing dot", () => {
    expect(normalizeDomain("example.com.")).toBe("example.com");
  });
  it("converts IDNs to punycode", () => {
    expect(normalizeDomain("bücher.de")).toBe("xn--bcher-kva.de");
  });
  it("rejects empty, whitespace, emails, URLs, and wildcards", () => {
    for (const bad of ["", "   ", "a b.com", "user@example.com", "https://example.com", "*.example.com", "example.com/x"]) {
      expect(normalizeDomain(bad)).toBeNull();
    }
  });
  it("rejects bare TLDs and malformed labels", () => {
    for (const bad of ["com", "-bad.com", "bad-.com", "ex..com", "exa_mple.com"]) {
      expect(normalizeDomain(bad)).toBeNull();
    }
  });
});

describe("normalizeDomains", () => {
  it("dedupes (case-insensitively) and sorts", () => {
    expect(normalizeDomains(["B.com", "a.com", "b.com"])).toEqual(["a.com", "b.com"]);
  });
  it("throws InvalidDomainError on a bad entry", () => {
    expect(() => normalizeDomains(["ok.com", "nope"])).toThrow(InvalidDomainError);
  });
});

describe("emailDomain", () => {
  it("extracts and normalizes the domain", () => {
    expect(emailDomain("User@Example.com")).toBe("example.com");
  });
  it("returns null for malformed addresses", () => {
    for (const bad of ["nope", "@example.com", "user@", "a@b@c.com"]) {
      expect(emailDomain(bad)).toBeNull();
    }
  });
});

describe("domainMatchesAllowlist", () => {
  it("allows all when the list is empty (generic predicate)", () => {
    expect(domainMatchesAllowlist("example.com", [])).toBe(true);
    expect(domainMatchesAllowlist(null, [])).toBe(true);
  });
  it("matches exactly and rejects subdomains unless explicitly configured", () => {
    expect(domainMatchesAllowlist("example.com", ["example.com"])).toBe(true);
    expect(domainMatchesAllowlist("sub.example.com", ["example.com"])).toBe(false);
    expect(domainMatchesAllowlist("sub.example.com", ["sub.example.com", "example.com"])).toBe(true);
  });
  it("returns false for an unparseable domain against a non-empty list", () => {
    expect(domainMatchesAllowlist(null, ["example.com"])).toBe(false);
  });
});
