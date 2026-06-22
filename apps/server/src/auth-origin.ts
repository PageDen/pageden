// Helpers for multi-tenant auth across workspace subdomains (cloud).
//
// Why this exists: Google OAuth uses a single fixed redirect URI on the apex
// (go.<base>), but "Continue with Google" is initiated from whatever host the
// user is on (e.g. acme.<base>). For the OAuth state cookie set at /start to be
// readable by the callback on the apex — and for the resulting session to be
// valid on the originating subdomain — auth cookies must be scoped to the
// parent base domain, and the callback must redirect back to the originating
// host. These helpers compute that cookie domain and validate the return host
// (so a forged origin cookie can't trigger an open redirect).
import { isReservedWorkspaceSubdomain, normalizeHostname } from "./workspaces/domains.js";

export interface AuthOriginEnv {
  webOrigin: string;
  baseDomain: string | null | undefined;
  cloudHosted: boolean;
}

/**
 * Cookie `domain` that shares the session across every workspace subdomain of
 * the base domain. Returns undefined off-cloud (self-host keeps host-only
 * cookies — no behavior change).
 */
export function sharedCookieDomain(env: AuthOriginEnv): string | undefined {
  if (!env.cloudHosted || !env.baseDomain) return undefined;
  const base = normalizeHostname(env.baseDomain);
  return base ? `.${base}` : undefined;
}

/**
 * Resolve the origin to return to after the OAuth round-trip. Only the apex or
 * a real cloud workspace subdomain of the base domain is trusted; anything else
 * falls back to the apex (webOrigin). This is the single open-redirect gate —
 * call it on the host read back from the (untrusted) origin cookie.
 */
export function resolveReturnOrigin(host: string | undefined, env: AuthOriginEnv): string {
  const fallback = env.webOrigin;
  if (!host) return fallback;
  const hostname = normalizeHostname(host);
  if (!hostname) return fallback;

  let apexHost: string;
  let scheme: string;
  try {
    const url = new URL(env.webOrigin);
    apexHost = url.hostname;
    scheme = url.protocol;
  } catch {
    return fallback;
  }
  if (hostname === apexHost) return fallback;

  if (env.cloudHosted && env.baseDomain) {
    const base = normalizeHostname(env.baseDomain);
    if (base && hostname.endsWith(`.${base}`)) {
      const subdomain = hostname.slice(0, -(base.length + 1));
      if (subdomain && !subdomain.includes(".") && !isReservedWorkspaceSubdomain(subdomain)) {
        return `${scheme}//${hostname}`;
      }
    }
  }
  return fallback;
}

/**
 * True if an Origin/Referer origin string belongs to this deployment — the apex
 * or a real cloud workspace subdomain of the base domain. Used by the CSRF guard
 * so cookie-authenticated mutations work on subdomains, not just the apex.
 */
export function isTrustedWebOrigin(candidate: string | null | undefined, env: AuthOriginEnv): boolean {
  if (!candidate) return false;
  if (candidate === env.webOrigin) return true;
  let host: string;
  try {
    host = new URL(candidate).host;
  } catch {
    return false;
  }
  return resolveReturnOrigin(host, env) === candidate;
}
