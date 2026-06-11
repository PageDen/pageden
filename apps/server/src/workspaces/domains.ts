import type { FastifyRequest } from "fastify";
import { env } from "../env.js";

export type WorkspaceHostRoute =
  | { mode: "cloud_subdomain"; subdomain: string; customDomain?: never }
  | { mode: "custom_domain"; customDomain: string; subdomain?: never };

export const RESERVED_WORKSPACE_SUBDOMAINS = new Set([
  "admin",
  "api",
  "app",
  "assets",
  "auth",
  "billing",
  "blog",
  "cdn",
  "dashboard",
  "docs",
  "go",
  "help",
  "mail",
  "marketing",
  "status",
  "support",
  "www",
]);

export const BLOCKED_WORKSPACE_SUBDOMAIN_TERMS = new Set([
  "abuse",
  "adminsupport",
  "asshole",
  "bastard",
  "bitch",
  "bloody",
  "boob",
  "boobs",
  "bullshit",
  "clit",
  "cock",
  "cunt",
  "damn",
  "dick",
  "dildo",
  "fag",
  "faggot",
  "fuck",
  "fucker",
  "fucking",
  "fuckoff",
  "fuckyou",
  "hitler",
  "kkk",
  "nazi",
  "nigga",
  "nigger",
  "penis",
  "porn",
  "porno",
  "pussy",
  "rape",
  "rapist",
  "scam",
  "scammer",
  "sex",
  "shit",
  "slut",
  "tits",
  "vagina",
  "whore",
]);

export function normalizeWorkspaceSubdomain(input: string): string {
  return input.trim().toLowerCase();
}

export function validateWorkspaceSubdomain(input: string): string | null {
  const value = normalizeWorkspaceSubdomain(input);
  if (value.length < 2) return "Workspace URL must be at least 2 characters.";
  if (value.length > 32) return "Workspace URL must be 32 characters or less.";
  if (!/^[a-z0-9-]+$/.test(value)) return "Use only lowercase letters, numbers, and dashes.";
  if (value.startsWith("-") || value.endsWith("-")) return "Workspace URL cannot start or end with a dash.";
  if (isReservedWorkspaceSubdomain(value)) return "That workspace URL is reserved.";
  if (hasBlockedWorkspaceSubdomainTerm(value)) return "Choose a professional workspace URL.";
  return null;
}

export function validateCustomDomain(input: string): string | null {
  const hostname = normalizeHostname(input);
  if (!hostname) return "Custom domain is required.";
  if (hostname.length > 255) return "Custom domain must be 255 characters or less.";
  if (!hostname.includes(".")) return "Custom domain must include a top-level domain.";
  if (!/^[a-z0-9.-]+$/.test(hostname)) return "Use only lowercase letters, numbers, dots, and dashes.";
  if (hostname.split(".").some((part) => !part || part.startsWith("-") || part.endsWith("-"))) {
    return "Custom domain labels cannot be empty or start/end with a dash.";
  }
  const baseDomain = env.baseDomain ? normalizeHostname(env.baseDomain) : null;
  if (baseDomain && (hostname === baseDomain || hostname.endsWith(`.${baseDomain}`))) {
    return "Use workspace subdomains for Pageden-owned domains.";
  }
  return null;
}

export function normalizeHostname(input: string): string {
  const value = input.trim().toLowerCase();
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname;
  } catch {
    return value.split(":")[0] ?? value;
  }
}

export function isReservedWorkspaceSubdomain(value: string): boolean {
  return RESERVED_WORKSPACE_SUBDOMAINS.has(value.trim().toLowerCase());
}

export function hasBlockedWorkspaceSubdomainTerm(value: string): boolean {
  const normalized = normalizeWorkspaceSubdomain(value);
  if (BLOCKED_WORKSPACE_SUBDOMAIN_TERMS.has(normalized)) return true;
  if (BLOCKED_WORKSPACE_SUBDOMAIN_TERMS.has(normalized.replaceAll("-", ""))) return true;
  return normalized.split("-").some((part) => BLOCKED_WORKSPACE_SUBDOMAIN_TERMS.has(part));
}

export function workspaceSubdomainFromHost(host: string): string | null {
  if (!env.cloudHosted || !env.baseDomain) return null;
  const hostname = normalizeHostname(host);
  const baseDomain = normalizeHostname(env.baseDomain);
  if (hostname === baseDomain) return null;
  if (!hostname.endsWith(`.${baseDomain}`)) return null;

  const subdomain = hostname.slice(0, -(baseDomain.length + 1));
  if (!subdomain || subdomain.includes(".")) return null;
  if (isReservedWorkspaceSubdomain(subdomain)) return null;
  return subdomain;
}

export function workspaceRouteFromHost(host: string): WorkspaceHostRoute | null {
  if (!env.cloudHosted) return null;
  const hostname = normalizeHostname(host);
  if (!hostname) return null;
  const baseDomain = env.baseDomain ? normalizeHostname(env.baseDomain) : null;
  const subdomain = workspaceSubdomainFromHost(host);
  if (subdomain) return { mode: "cloud_subdomain", subdomain };
  if (baseDomain && (hostname === baseDomain || hostname.endsWith(`.${baseDomain}`))) return null;
  if (!baseDomain || hostname !== baseDomain) {
    return { mode: "custom_domain", customDomain: hostname };
  }
  return null;
}

export function requestHost(request: FastifyRequest): string {
  const forwarded = request.headers["x-forwarded-host"];
  const host = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? request.headers.host ?? "";
  return host.split(",")[0]?.trim() ?? "";
}
