import { describe, it, expect } from "vitest";
import { rehypeAllowlistIframes } from "./media-sanitize.js";

type N = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: N[]; value?: string };
const iframe = (src: string): N => ({ type: "element", tagName: "iframe", properties: { src }, children: [] });

describe("rehypeAllowlistIframes", () => {
  it("keeps allowlisted embeds and removes everything else", () => {
    const tree: N = {
      type: "root",
      children: [
        iframe("https://www.youtube-nocookie.com/embed/abc"),
        iframe("https://player.vimeo.com/video/1"),
        iframe("https://evil.example/embed"),
        iframe("javascript:alert(1)"),
        { type: "element", tagName: "p", properties: {}, children: [{ type: "text", value: "hi" }] },
      ],
    };
    rehypeAllowlistIframes()(tree);
    const iframes = (tree.children ?? []).filter((c) => c.tagName === "iframe");
    expect(iframes).toHaveLength(2);
    expect((tree.children ?? []).some((c) => c.tagName === "p")).toBe(true);
  });
});
