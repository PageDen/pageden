// Shared analytics event bus. Self-contained — no external deps, no cloud
// references — so this file (and the call sites in product code) are
// identical between the cloud overlay and the self-hosted (public) build.
//
// Product code calls track() / identifyUser() / resetAnalytics() /
// trackPageview() against this module. By default nothing is registered,
// so every call is a no-op — the right behavior for self-hosted.
//
// In the cloud build, main.tsx registers a Mixpanel-backed listener at
// startup; the same calls then flow through to Mixpanel.
//
// Add new events by extending the EventName union — TypeScript will then
// enforce the payload shape at every call site.

export type EventName =
  | "user_signed_in"
  | "user_signed_out"
  | "workspace_created"
  | "document_created"
  | "document_saved"
  | "folder_created"
  | "permission_granted"
  | "share_link_created"
  | "share_link_revoked"
  | "vault_import_completed";

export type EventProperties = Record<string, string | number | boolean | null | undefined>;

export type IdentityProperties = {
  email?: string;
  name?: string;
  workspaceCount?: number;
};

export type AnalyticsListener = {
  track(event: string, properties: EventProperties): void;
  identify(userId: string, properties: IdentityProperties): void;
  reset(): void;
  pageview(path: string): void;
};

let listener: AnalyticsListener | null = null;

/** Plug in a backend (e.g., Mixpanel) for telemetry. Pass null to unregister. */
export function registerAnalyticsListener(next: AnalyticsListener | null): void {
  listener = next;
}

/** Track a domain event. Add new events to the EventName union above. */
export function track(event: EventName, properties: EventProperties = {}): void {
  listener?.track(event, properties);
}

/** Associate the current session with a logged-in user. */
export function identifyUser(userId: string, properties: IdentityProperties = {}): void {
  if (!userId) return;
  listener?.identify(userId, properties);
}

/** Clear the user binding on sign-out so the next session starts anonymous. */
export function resetAnalytics(): void {
  listener?.reset();
}

/** Track a manual pageview after route change. Path only — no querystring. */
export function trackPageview(path: string): void {
  listener?.pageview(path);
}
