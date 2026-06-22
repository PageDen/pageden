// Shared server-side analytics event bus. Mirrors apps/web/src/lib/analytics-
// bus.ts in spirit: vendor-neutral, self-contained, no external deps. Product
// code calls track() against this module from request handlers; when no
// listener is registered (every self-hosted build) every call is a cheap
// no-op and nothing leaves the box.
//
// The cloud overlay registers a Mixpanel-Node-backed listener at startup —
// see cloud/features/server/instrument.mjs in the pageden-cloud repo. The
// overlay sets a globalThis hook before any application code runs (via
// `node --import .../instrument.mjs`), and this module picks it up at
// import time. Self-hosted leaves the hook unset, so the bus stays silent.
//
// Server-side events ALWAYS carry a workspaceId — it's the unit of analysis.
// The bus enforces this at the type level. No identifyUser equivalent here:
// server events are about workspace-scoped actions (agent/MCP calls, agent
// writes, plugin pushes, imports), not user sessions.
//
// Add new events by extending the ServerEventName union — TypeScript will
// then force the payload at every call site.

export type ServerEventName =
  | "workspace_created"
  | "agent_mcp_call"
  | "agent_document_created"
  | "agent_document_saved"
  | "agent_document_read"
  | "plugin_push_completed"
  | "import_completed";

export type ServerEventProperties = Record<string, string | number | boolean | null | undefined>;

/**
 * Who triggered the event. Resolves to Mixpanel's `distinct_id`:
 * - `userId` is preferred — every agent token is bound to one human owner.
 * - `tokenId` is the fallback for tokens with no resolvable user (rare).
 *
 * If neither is set the listener may drop the event since there's no actor
 * to attribute it to.
 */
export type ServerActor = {
  userId?: string | null;
  tokenId?: string | null;
};

export type ServerEventPayload = {
  workspaceId: string;
  actor: ServerActor;
  properties: ServerEventProperties;
};

export type ServerAnalyticsListener = {
  track(event: string, payload: ServerEventPayload): void;
  /** Optional graceful shutdown so the SDK can flush its queue. */
  flush?(): Promise<void> | void;
};

let listener: ServerAnalyticsListener | null = null;

/** Plug in a backend (e.g., Mixpanel Node). Pass null to unregister. */
export function registerServerAnalyticsListener(next: ServerAnalyticsListener | null): void {
  listener = next;
}

/**
 * Emit an analytics event.
 * - `workspaceId` is required — the bus attaches it as `workspace_id` so
 *   call sites can't forget. Cloud listeners also use it as the Mixpanel
 *   group key so events join the per-workspace rollup.
 * - `actor` carries who triggered the event so Mixpanel can set
 *   `distinct_id` correctly; without it, agent events would attribute
 *   anonymously and the per-workspace cohort wouldn't include them.
 *
 * Never throws.
 */
export function trackServerEvent(
  event: ServerEventName,
  workspaceId: string,
  actor: ServerActor,
  properties: ServerEventProperties = {},
): void {
  if (!listener || !workspaceId) return;
  try {
    listener.track(event, {
      workspaceId,
      actor,
      properties: { ...properties, workspace_id: workspaceId },
    });
  } catch {
    // never throw from telemetry
  }
}

/** Flush any queued events. Call from the server shutdown hook. */
export async function flushServerAnalytics(): Promise<void> {
  if (!listener?.flush) return;
  try {
    await listener.flush();
  } catch {
    // never throw
  }
}

// --------------------------------------------------------------------------
// Bootstrap: pick up a listener installed by the cloud overlay's --import
// preload. instrument.mjs sets globalThis.__pagedenServerAnalyticsListener
// after creating the Mixpanel client; we register it once at module load.
// Self-hosted builds never set the global, so this branch is dead code in
// that build (and a no-op in this one if no overlay is present).
// --------------------------------------------------------------------------

const BOOTSTRAP_KEY = "__pagedenServerAnalyticsListener" as const;

type GlobalWithBootstrap = typeof globalThis & {
  [BOOTSTRAP_KEY]?: ServerAnalyticsListener;
};

const bootstrap = (globalThis as GlobalWithBootstrap)[BOOTSTRAP_KEY];
if (bootstrap && typeof bootstrap.track === "function") {
  listener = bootstrap;
}
