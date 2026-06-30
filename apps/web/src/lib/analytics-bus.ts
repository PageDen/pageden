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
// Workspace context: setWorkspaceContext(workspaceId) declares the active
// workspace once (typically from workspace-shell on /me resolve). The bus
// auto-attaches workspace_id to every subsequent track() call, and the
// listener can hook this to register a group key — Mixpanel group
// analytics, Amplitude account_id, etc. — so the same metric can be
// rolled up per-workspace without every call site remembering to pass it.
//
// Add new events by extending the EventName union — TypeScript will then
// enforce the payload shape at every call site.

export type EventName =
  | "user_signed_in"
  | "user_signed_out"
  | "workspace_created"
  | "document_created"
  | "document_read"
  | "document_reference_copied"
  | "document_saved"
  | "document_marked_canonical"
  | "document_restored"
  | "folder_created"
  | "permission_granted"
  | "share_link_created"
  | "share_link_revoked"
  | "search_performed"
  | "agent_token_created"
  | "member_invited"
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
  /** Optional hook for backends that support group analytics (e.g. Mixpanel groups). */
  setWorkspaceContext?(workspaceId: string | null): void;
};

let listener: AnalyticsListener | null = null;
let activeWorkspaceId: string | null = null;

/** Plug in a backend (e.g., Mixpanel) for telemetry. Pass null to unregister. */
export function registerAnalyticsListener(next: AnalyticsListener | null): void {
  listener = next;
  // Re-apply any existing workspace context to the new listener so events
  // it sees from this point already carry the group key.
  if (next && activeWorkspaceId !== null) {
    try {
      next.setWorkspaceContext?.(activeWorkspaceId);
    } catch {
      // never throw from telemetry
    }
  }
}

/**
 * Declare the active workspace so every subsequent track() call auto-attaches
 * workspace_id and the listener can register the group key. Pass null to
 * clear (e.g., on workspace switch or logout).
 */
export function setWorkspaceContext(workspaceId: string | null): void {
  if (activeWorkspaceId === workspaceId) return;
  activeWorkspaceId = workspaceId;
  if (!listener) return;
  try {
    listener.setWorkspaceContext?.(workspaceId);
  } catch {
    // never throw
  }
}

/** Track a domain event. Add new events to the EventName union above. */
export function track(event: EventName, properties: EventProperties = {}): void {
  if (!listener) return;
  // workspace_id is auto-attached when a context is set, but a call site
  // can still override it (e.g., emitting for a different workspace).
  const merged: EventProperties =
    activeWorkspaceId !== null && properties.workspace_id === undefined
      ? { ...properties, workspace_id: activeWorkspaceId }
      : properties;
  try {
    listener.track(event, merged);
  } catch {
    // never throw
  }
}

/** Associate the current session with a logged-in user. */
export function identifyUser(userId: string, properties: IdentityProperties = {}): void {
  if (!userId) return;
  listener?.identify(userId, properties);
}

/** Clear the user binding on sign-out so the next session starts anonymous. */
export function resetAnalytics(): void {
  activeWorkspaceId = null;
  listener?.reset();
}

/** Track a manual pageview after route change. Path only — no querystring. */
export function trackPageview(path: string): void {
  listener?.pageview(path);
}
