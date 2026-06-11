import { afterEach, describe, expect, it, vi } from "vitest";

async function loadDomains(env: Record<string, string | undefined>) {
  vi.resetModules();
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
  process.env.SESSION_SECRET = "test-session-secret-0123456789-abcdefgh";
  process.env.TOKEN_HASH_SECRET = "test-token-hash-secret-0123456789-abcdef";
  process.env.WEB_ORIGIN = "http://localhost:3000";
  delete process.env.CLOUD_HOSTED;
  delete process.env.BASE_DOMAIN;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import("./domains.js");
}

afterEach(() => {
  vi.resetModules();
});

describe("workspace host routing", () => {
  it("does not resolve workspace subdomains for self-hosted installs", async () => {
    const { workspaceRouteFromHost, workspaceSubdomainFromHost } = await loadDomains({
      CLOUD_HOSTED: "false",
      BASE_DOMAIN: "pageden.com",
    });

    expect(workspaceSubdomainFromHost("acme.pageden.com")).toBeNull();
    expect(workspaceRouteFromHost("acme.pageden.com")).toBeNull();
  });

  it("resolves a single cloud workspace subdomain", async () => {
    const { workspaceRouteFromHost, workspaceSubdomainFromHost } = await loadDomains({
      CLOUD_HOSTED: "true",
      BASE_DOMAIN: "pageden.com",
    });

    expect(workspaceSubdomainFromHost("Acme.pageden.com:443")).toBe("acme");
    expect(workspaceRouteFromHost("acme.pageden.com")).toEqual({ mode: "cloud_subdomain", subdomain: "acme" });
  });

  it("ignores base, nested, and reserved cloud subdomains", async () => {
    const { workspaceRouteFromHost, workspaceSubdomainFromHost } = await loadDomains({
      CLOUD_HOSTED: "true",
      BASE_DOMAIN: "pageden.com",
    });

    expect(workspaceSubdomainFromHost("pageden.com")).toBeNull();
    expect(workspaceSubdomainFromHost("team.eu.pageden.com")).toBeNull();
    expect(workspaceSubdomainFromHost("app.pageden.com")).toBeNull();
    expect(workspaceRouteFromHost("app.pageden.com")).toBeNull();
  });

  it("treats non-base-domain hosts as custom domains only in cloud mode", async () => {
    const { workspaceRouteFromHost } = await loadDomains({
      CLOUD_HOSTED: "true",
      BASE_DOMAIN: "pageden.com",
    });

    expect(workspaceRouteFromHost("docs.example.com")).toEqual({ mode: "custom_domain", customDomain: "docs.example.com" });
  });

  it("validates workspace subdomains for public signup", async () => {
    const { normalizeWorkspaceSubdomain, validateWorkspaceSubdomain } = await loadDomains({
      CLOUD_HOSTED: "true",
      BASE_DOMAIN: "pageden.com",
    });

    expect(normalizeWorkspaceSubdomain(" Acme-Team ")).toBe("acme-team");
    expect(validateWorkspaceSubdomain("acme-team")).toBeNull();
    expect(validateWorkspaceSubdomain("a")).toContain("at least 2");
    expect(validateWorkspaceSubdomain("go")).toContain("reserved");
    expect(validateWorkspaceSubdomain("-acme")).toContain("dash");
    expect(validateWorkspaceSubdomain("acme_")).toContain("lowercase");
    expect(validateWorkspaceSubdomain("scam")).toContain("professional");
    expect(validateWorkspaceSubdomain("my-scam-site")).toContain("professional");
    expect(validateWorkspaceSubdomain("f-u-c-k")).toContain("professional");
  });

  it("validates custom domains without accepting Pageden-owned hosts", async () => {
    const { normalizeHostname, validateCustomDomain } = await loadDomains({
      CLOUD_HOSTED: "true",
      BASE_DOMAIN: "pageden.com",
    });

    expect(normalizeHostname("HTTPS://Docs.Example.COM/path")).toBe("docs.example.com");
    expect(validateCustomDomain("docs.example.com")).toBeNull();
    expect(validateCustomDomain("acme.pageden.com")).toContain("Pageden-owned");
    expect(validateCustomDomain("localhost")).toContain("top-level");
    expect(validateCustomDomain("bad_domain.com")).toContain("lowercase");
  });
});
