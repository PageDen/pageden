/**
 * Signup guard — optional extension point for signup abuse controls.
 *
 * Deployments may register a guard (CAPTCHA verification, domain blocklists, quotas, …)
 * that is consulted before any self-service account creation (password or Google) and
 * before password-recovery emails. When no guard is registered (the default), behavior
 * is unchanged and everything is allowed.
 */

export interface SignupGuardInput {
  /** Normalized (lowercased, trimmed) email address. */
  email: string;
  /** The part after "@" of the normalized email. */
  emailDomain: string;
  /** Client IP as seen by the server (X-Real-IP behind a proxy). */
  ip: string;
  /** CAPTCHA response token from the client (password flows only). */
  captchaToken?: string;
  kind: "register" | "forgot-password";
  source: "password" | "google";
}

export type SignupGuardReason = "captcha_failed" | "domain_blocked" | "quota_exceeded" | "signups_paused";

export interface SignupGuardResult {
  allow: boolean;
  reason?: SignupGuardReason;
}

export type SignupGuard = (input: SignupGuardInput) => Promise<SignupGuardResult>;

/** CAPTCHA widget configuration surfaced to the web client via /api/auth/config. */
export interface SignupGuardCaptcha {
  provider: "turnstile";
  siteKey: string;
}

let guard: SignupGuard | null = null;
let captcha: SignupGuardCaptcha | null = null;

export function setSignupGuard(next: SignupGuard | null, options: { captcha?: SignupGuardCaptcha | null } = {}): void {
  guard = next;
  captcha = options.captcha ?? null;
}

/** The CAPTCHA config the web client should render, or null when none is configured. */
export function getSignupGuardCaptcha(): SignupGuardCaptcha | null {
  return captcha;
}

export async function runSignupGuard(input: SignupGuardInput): Promise<SignupGuardResult> {
  if (!guard) return { allow: true };
  return guard(input);
}
