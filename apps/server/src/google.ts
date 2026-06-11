import { Google, generateCodeVerifier, generateState } from "arctic";
import { env, googleConfigured } from "./env.js";

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

export interface GoogleClient {
  createAuthorizationURL(state: string, codeVerifier: string): URL;
  profileFromCode(code: string, codeVerifier: string): Promise<GoogleProfile>;
}

// The id_token comes straight from Google's token endpoint over TLS via the authorization-code
// exchange, so we read its claims without re-verifying the signature.
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

// The id_token comes from the direct server↔Google code exchange over TLS, but we still validate
// the standard OIDC claims (issuer, audience, expiry) before trusting it. (Full JWKS signature
// verification is a further hardening; the token's provenance via the TLS exchange makes forgery
// require compromising that channel.)
export function decodeIdToken(idToken: string, expectedAudience: string): GoogleProfile {
  const segment = idToken.split(".")[1] ?? "";
  const payload = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
  if (!GOOGLE_ISSUERS.has(String(payload.iss ?? ""))) throw new Error("Unexpected id_token issuer.");
  if (String(payload.aud ?? "") !== expectedAudience) throw new Error("Unexpected id_token audience.");
  const exp = Number(payload.exp ?? 0);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now() - 60_000) throw new Error("id_token has expired.");
  const sub = String(payload.sub ?? "");
  if (!sub) throw new Error("id_token missing subject.");
  return {
    sub,
    email: String(payload.email ?? "").trim().toLowerCase(),
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
    name: String(payload.name ?? payload.email ?? "").trim(),
  };
}

export function buildGoogleClient(clientId: string, clientSecret: string, redirectUri: string): GoogleClient {
  const google = new Google(clientId, clientSecret, redirectUri);
  return {
    createAuthorizationURL(state, codeVerifier) {
      return google.createAuthorizationURL(state, codeVerifier, ["openid", "profile", "email"]);
    },
    async profileFromCode(code, codeVerifier) {
      const tokens = await google.validateAuthorizationCode(code, codeVerifier);
      return decodeIdToken(tokens.idToken(), clientId);
    },
  };
}

function createDefaultClient(): GoogleClient | null {
  if (!googleConfigured) return null;
  return buildGoogleClient(env.googleClientId!, env.googleClientSecret!, env.googleRedirectUri);
}

let client: GoogleClient | null = createDefaultClient();
export function getGoogleClient(): GoogleClient | null {
  return client;
}
// Test seam: inject a fake client (and reset to the env-derived default with null+rebuild).
export function setGoogleClient(next: GoogleClient | null): void {
  client = next;
}

export { generateCodeVerifier, generateState };
