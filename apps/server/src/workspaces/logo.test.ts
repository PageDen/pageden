import { describe, expect, it } from "vitest";
import { sanitizeSvg, workspaceLogoUrl } from "./logo.js";

describe("sanitizeSvg", () => {
  it("strips <script> elements", () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>`;
    const out = sanitizeSvg(Buffer.from(dirty)).toString("utf8");
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain("<rect");
  });

  it("strips event-handler attributes and javascript: hrefs", () => {
    const dirty = `<svg onload="steal()"><a href="javascript:evil()"><circle/></a></svg>`;
    const out = sanitizeSvg(Buffer.from(dirty)).toString("utf8");
    expect(out).not.toMatch(/onload/i);
    expect(out).not.toMatch(/javascript:/i);
    expect(out).toContain("<circle");
  });

  it("strips <foreignObject>", () => {
    const dirty = `<svg><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><script>x</script></body></foreignObject></svg>`;
    const out = sanitizeSvg(Buffer.from(dirty)).toString("utf8");
    expect(out).not.toMatch(/foreignObject/i);
  });
});

describe("workspaceLogoUrl", () => {
  it("returns a versioned url when a logo is set", () => {
    expect(workspaceLogoUrl({ id: "ws1", logoStorageKey: "k", logoSha: "abc" })).toBe("/api/workspaces/ws1/logo?v=abc");
  });

  it("returns null when no logo is set", () => {
    expect(workspaceLogoUrl({ id: "ws1", logoStorageKey: null, logoSha: null })).toBeNull();
  });
});
