import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flushServerAnalytics,
  identifyServerUser,
  registerServerAnalyticsListener,
  trackServerEvent,
  trackServerUserEvent,
  type ServerEventPayload,
  type ServerUserEventPayload,
} from "./analytics-bus.js";

afterEach(() => {
  registerServerAnalyticsListener(null);
  delete (globalThis as typeof globalThis & { __pagedenServerAnalyticsListener?: unknown }).__pagedenServerAnalyticsListener;
  vi.resetModules();
});

describe("server analytics bus", () => {
  it("is a no-op when no listener is registered or workspaceId is missing", () => {
    expect(() => {
      trackServerEvent("agent_mcp_call", "workspace-1", { userId: "user-1" });
      trackServerEvent("agent_mcp_call", "", { userId: "user-1" });
    }).not.toThrow();
  });

  it("sends events with workspace enrichment to the registered listener", () => {
    const track = vi.fn((event: string, payload: ServerEventPayload) => {
      void event;
      void payload;
    });
    registerServerAnalyticsListener({ track });

    trackServerEvent("agent_document_read", "workspace-1", { userId: "user-1", tokenId: null }, { surface: "integration_rest" });

    expect(track).toHaveBeenCalledWith("agent_document_read", {
      workspaceId: "workspace-1",
      actor: { userId: "user-1", tokenId: null },
      properties: { surface: "integration_rest", workspace_id: "workspace-1" },
    });
  });

  it("never throws when listener track or flush fails", async () => {
    registerServerAnalyticsListener({
      track() {
        throw new Error("track failed");
      },
      trackUser() {
        throw new Error("trackUser failed");
      },
      identify() {
        throw new Error("identify failed");
      },
      flush() {
        throw new Error("flush failed");
      },
    });

    expect(() => trackServerEvent("agent_document_saved", "workspace-1", { tokenId: "token-1" })).not.toThrow();
    expect(() => trackServerUserEvent("user_signed_in", { userId: "user-1" })).not.toThrow();
    expect(() => identifyServerUser("user-1", { email: "user@example.com" })).not.toThrow();
    await expect(flushServerAnalytics()).resolves.toBeUndefined();
  });

  it("sends user-scoped events and identity updates when supported", () => {
    const track = vi.fn();
    const trackUser = vi.fn((event: string, payload: ServerUserEventPayload) => {
      void event;
      void payload;
    });
    const identify = vi.fn();
    registerServerAnalyticsListener({ track, trackUser, identify });

    trackServerUserEvent("user_signed_in", { userId: "user-1" }, { method: "google" });
    identifyServerUser("user-1", { email: "user@example.com", workspaceCount: 2 });

    expect(track).not.toHaveBeenCalled();
    expect(trackUser).toHaveBeenCalledWith("user_signed_in", {
      actor: { userId: "user-1" },
      properties: { method: "google" },
    });
    expect(identify).toHaveBeenCalledWith("user-1", { email: "user@example.com", workspaceCount: 2 });
  });

  it("flushes listener queues when provided", async () => {
    const flush = vi.fn(async () => {});
    registerServerAnalyticsListener({ track() {}, flush });

    await flushServerAnalytics();

    expect(flush).toHaveBeenCalledOnce();
  });

  it("bootstraps a listener from the cloud overlay global", async () => {
    const track = vi.fn((event: string, payload: ServerEventPayload) => {
      void event;
      void payload;
    });
    (globalThis as typeof globalThis & { __pagedenServerAnalyticsListener?: { track: typeof track } }).__pagedenServerAnalyticsListener = { track };

    const bus = await import("./analytics-bus.js");
    bus.trackServerEvent("agent_mcp_call", "workspace-1", { userId: "user-1" });

    expect(track).toHaveBeenCalledOnce();
  });
});
