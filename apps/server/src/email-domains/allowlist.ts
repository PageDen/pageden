import { domainToASCII } from "node:url";
import { prisma } from "../prisma.js";

export class InvalidDomainError extends Error {
  constructor(public readonly input: string) {
    super(`Invalid email domain: ${input}`);
    this.name = "InvalidDomainError";
  }
}

/**
 * Normalize a single allowlist entry to a canonical bare domain, or return null
 * if it is not a valid domain.
 *
 * Rules: lowercase + trim, strip a single trailing dot, convert IDNs to punycode
 * (ASCII), reject empty/whitespace/email/URL/wildcard inputs, and require a
 * strict FQDN shape (>= 2 labels of [a-z0-9-], no leading/trailing dash).
 * Wildcards and subdomain inheritance are intentionally out of scope.
 */
export function normalizeDomain(input: string): string | null {
  if (typeof input !== "string") return null;
  let value = input.trim().toLowerCase();
  if (!value) return null;
  if (/\s/.test(value)) return null; // no internal whitespace
  if (value.includes("@") || value.includes("/") || value.includes(":") || value.includes("*")) return null; // not an email/URL/wildcard
  if (value.endsWith(".")) value = value.slice(0, -1); // strip a single trailing dot
  if (!value) return null;

  // IDN -> punycode. domainToASCII returns "" when it cannot process the input.
  const ascii = domainToASCII(value);
  if (!ascii) return null;
  value = ascii;

  if (value.length > 253) return null;
  const labels = value.split(".");
  if (labels.length < 2) return null; // require a dotted FQDN, not a bare TLD
  for (const label of labels) {
    if (!label || label.length > 63) return null;
    if (!/^[a-z0-9-]+$/.test(label)) return null;
    if (label.startsWith("-") || label.endsWith("-")) return null;
  }
  return value;
}

/** Normalize, validate, dedupe, and sort a list of domains. Throws InvalidDomainError on a bad entry. */
export function normalizeDomains(inputs: string[]): string[] {
  const out = new Set<string>();
  for (const raw of inputs) {
    const normalized = normalizeDomain(raw);
    if (normalized === null) throw new InvalidDomainError(raw);
    out.add(normalized);
  }
  return [...out].sort();
}

/** Extract the normalized domain from an email address, or null if it cannot be parsed. */
export function emailDomain(email: string): string | null {
  if (typeof email !== "string") return null;
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  if (email.slice(0, at).includes("@")) return null; // stray @ in local part
  return normalizeDomain(email.slice(at + 1));
}

/**
 * Generic predicate: is `domain` permitted by `allowed`?
 * An empty allowlist means "no restriction" (allow all). The cloud subdomain
 * self-join gate adds the separate requirement that the allowlist be non-empty,
 * so this branch never authorizes a self-join on its own.
 */
export function domainMatchesAllowlist(domain: string | null, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  if (!domain) return false;
  return allowed.includes(domain);
}

/**
 * Workspace-scoped generic predicate. Empty allowlist = allowed.
 *
 * The self-join enforcement surface (cloud) is responsible for the additional
 * "verified email AND non-empty allowlist" rule; this helper is the reusable
 * domain-match check.
 */
export async function isWorkspaceEmailDomainAllowed(workspaceId: string, email: string): Promise<boolean> {
  const rows = await prisma.workspaceAllowedEmailDomain.findMany({
    where: { workspaceId },
    select: { domain: true },
  });
  return domainMatchesAllowlist(emailDomain(email), rows.map((row) => row.domain));
}
