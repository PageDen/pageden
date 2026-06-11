import { describe, it, expect } from "vitest";
import { parseCookieHeader } from "./cookies.js";

describe("parseCookieHeader", () => {
  it("parses name=value pairs and decodes percent-encoding", () => {
    expect(parseCookieHeader("pm_session=abc; other=1")).toEqual({ pm_session: "abc", other: "1" });
    expect(parseCookieHeader("x=a%20b")).toEqual({ x: "a b" });
  });
  it("skips malformed segments (no '=', empty name)", () => {
    expect(parseCookieHeader("novalue; =orphan; ok=1")).toEqual({ ok: "1" });
    expect(parseCookieHeader("")).toEqual({});
  });
  it("falls back to the raw value when decoding fails", () => {
    expect(parseCookieHeader("x=%E0%A4%A")).toEqual({ x: "%E0%A4%A" });
  });
});
