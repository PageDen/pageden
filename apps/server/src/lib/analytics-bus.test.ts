import { afterEach, describe, expect, it, vi } from "vitest";
import { flushServerAnalytics, registerServerAnalyticsListener, trackServerEvent, type ServerEventPayload } from "./analytics-bus.js";

afterEach(() => {
  registerServerAnalyticsListener(null);
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
      flush() {
        throw new Error("flush failed");
      },
    });

    expect(() => trackServerEvent("agent_document_saved", "workspace-1", { tokenId: "token-1" })).not.toThrow();
    await expect(flushServerAnalytics()).resolves.toBeUndefined();
  });

  it("flushes listener queues when provided", async () => {
    const flush = vi.fn(async () => {});
    registerServerAnalyticsListener({ track() {}, flush });

    await flushServerAnalytics();

    expect(flush).toHaveBeenCalledOnce();
  });
});
