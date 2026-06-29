import { describe, expect, it, vi } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { csrfGuard } from "./csrf.js";

function reply() {
  return {
    code: vi.fn().mockReturnThis(),
    send: vi.fn(),
  } as unknown as FastifyReply & { code: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
}

function request(input: Partial<FastifyRequest>): FastifyRequest {
  return {
    method: "POST",
    url: "/api/documents",
    headers: {},
    cookies: {},
    ...input,
  } as FastifyRequest;
}

describe("csrf guard", () => {
  it("allows safe methods", () => {
    const done = vi.fn();
    csrfGuard(request({ method: "GET" }), reply(), done);
    expect(done).toHaveBeenCalledOnce();
  });

  it("rejects malformed referer origins", () => {
    const res = reply();
    const done = vi.fn();

    csrfGuard(request({ headers: { referer: "%%%not-a-url" } }), res, done);

    expect(done).not.toHaveBeenCalled();
    expect(res.code).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith({ error: "forbidden", message: "Invalid or missing request origin." });
  });

  it("exempts bearer-only requests", () => {
    const done = vi.fn();
    csrfGuard(request({ headers: { authorization: "Bearer token" } }), reply(), done);
    expect(done).toHaveBeenCalledOnce();
  });
});
