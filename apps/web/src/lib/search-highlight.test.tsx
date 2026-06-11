import { describe, it, expect } from "vitest";
import type { ReactElement } from "react";
import { highlightSnippet } from "./search-highlight";

const S = "\uE000";
const E = "\uE001";

type Seg = { type: string; text: unknown };
function segs(nodes: ReturnType<typeof highlightSnippet>): Seg[] {
  return (nodes as ReactElement<{ children: unknown }>[]).map((n) => ({ type: n.type as string, text: n.props.children }));
}

describe("highlightSnippet", () => {
  it("wraps only the marked spans in <mark> and keeps the rest as plain text", () => {
    expect(segs(highlightSnippet(`before ${S}match${E} after`))).toEqual([
      { type: "span", text: "before " },
      { type: "mark", text: "match" },
      { type: "span", text: " after" },
    ]);
  });

  it("never emits raw HTML — script-like content stays as escaped text children", () => {
    const nodes = highlightSnippet(`x ${S}<script>alert(1)</script>${E} y`);
    const mark = (nodes as ReactElement<{ children: unknown }>[]).find((n) => n.type === "mark");
    expect(mark?.props.children).toBe("<script>alert(1)</script>");
    // nothing uses dangerouslySetInnerHTML
    expect((nodes as ReactElement<Record<string, unknown>>[]).every((n) => !("dangerouslySetInnerHTML" in n.props))).toBe(true);
  });

  it("returns a single span when there are no markers", () => {
    const nodes = highlightSnippet("plain text");
    expect(nodes).toHaveLength(1);
    expect(segs(nodes)).toEqual([{ type: "span", text: "plain text" }]);
  });

  it("handles an unterminated start marker", () => {
    const nodes = highlightSnippet(`a ${S}b`);
    const mark = (nodes as ReactElement<{ children: unknown }>[]).find((n) => n.type === "mark");
    expect(mark?.props.children).toBe("b");
  });
});
