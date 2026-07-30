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

  // Vectors the earlier regex-based sanitizer let through. The parser-based implementation
  // blocks all of them; these cases exist so a "simplification" back to regexes fails CI
  // rather than silently reopening the holes.
  describe("vectors that defeat naive regex stripping", () => {
    it("strips an unquoted javascript: href", () => {
      const out = sanitizeSvg(Buffer.from(`<svg><a href=javascript:alert(1)><circle/></a></svg>`)).toString("utf8");
      expect(out).not.toMatch(/javascript:/i);
      expect(out).toContain("<circle");
    });

    it("strips a javascript: href hidden behind leading whitespace", () => {
      const out = sanitizeSvg(Buffer.from(`<svg><a href=" javascript:alert(1)"><circle/></a></svg>`)).toString("utf8");
      expect(out).not.toMatch(/javascript:/i);
    });

    it("strips a javascript: href broken up by control characters", () => {
      const out = sanitizeSvg(Buffer.from(`<svg><a href="java\tscript:alert(1)"><circle/></a></svg>`)).toString("utf8");
      expect(out).not.toMatch(/script:/i);
    });

    it.each(["iframe", "embed", "object", "video", "audio", "canvas"])("strips <%s>", (tag) => {
      const out = sanitizeSvg(Buffer.from(`<svg><${tag} src="https://evil.test/x"></${tag}><rect/></svg>`)).toString("utf8");
      expect(out.toLowerCase()).not.toContain(`<${tag}`);
      expect(out).not.toContain("evil.test");
      expect(out).toContain("<rect");
    });

    it("strips a self-closing <foreignObject/>", () => {
      const out = sanitizeSvg(Buffer.from(`<svg><foreignObject/><rect/></svg>`)).toString("utf8");
      expect(out).not.toMatch(/foreignObject/i);
      expect(out).toContain("<rect");
    });

    it("strips inline style attributes", () => {
      const out = sanitizeSvg(Buffer.from(`<svg><rect style="background:url(https://evil.test/x)"/></svg>`)).toString("utf8");
      expect(out).not.toMatch(/style=/i);
      expect(out).not.toContain("evil.test");
    });

    it("strips an external xlink:href while keeping same-document fragments", () => {
      const external = sanitizeSvg(Buffer.from(`<svg><use xlink:href="https://evil.test/x#a"/></svg>`)).toString("utf8");
      expect(external).not.toContain("evil.test");

      const internal = sanitizeSvg(Buffer.from(`<svg><use xlink:href="#gradient"/></svg>`)).toString("utf8");
      expect(internal).toContain("#gradient");
    });

    it("keeps ordinary drawing markup intact", () => {
      const clean = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 4h16v16H4z" fill="#123456"/></svg>`;
      const out = sanitizeSvg(Buffer.from(clean)).toString("utf8");
      expect(out).toContain("viewBox=\"0 0 24 24\"");
      expect(out).toContain("d=\"M4 4h16v16H4z\"");
      expect(out).toContain("fill=\"#123456\"");
    });
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
