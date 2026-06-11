import { defaultSchema } from "rehype-sanitize";
import type { Options } from "rehype-sanitize";
import { isAllowedEmbedSrc } from "./media";

// Sanitize schema for the read-only preview. Extends the safe default to permit our embedded
// media (uploaded <video>, allowlisted <iframe>, <img>) while still stripping scripts, event
// handlers, and unknown tags. Iframe HOST allowlisting is enforced again in the React
// component (defence in depth); here we just allow the tag + safe attributes over http(s).
const base = defaultSchema as Options;

export const previewSanitizeSchema: Options = {
  ...base,
  tagNames: [...(base.tagNames ?? []), "video", "source", "iframe"],
  attributes: {
    ...(base.attributes ?? {}),
    video: ["src", "controls", "preload", "poster", "width", "height", "className"],
    source: ["src", "type"],
    iframe: [
      "src",
      "width",
      "height",
      "allow",
      "allowfullscreen",
      "loading",
      "referrerpolicy",
      "frameborder",
      "title",
      "className",
    ],
    img: [...((base.attributes ?? {}).img ?? []), "className", "loading", "width", "height", "data-align"],
  },
  // Only http(s) for media sources (defaultSchema already restricts most; be explicit).
  protocols: {
    ...(base.protocols ?? {}),
    src: ["http", "https"],
  },
};

type HastNode = { type?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

// Defence in depth: after sanitization, drop any <iframe> whose src is not an allowlisted
// embed host. This protects EVERY render path that consumes the stored Markdown, not just the
// React preview component. rehype-sanitize keeps the tag but can't host-restrict it per-tag.
export function rehypeAllowlistIframes() {
  return (tree: HastNode): void => {
    const walk = (node: HastNode): void => {
      if (!Array.isArray(node.children)) return;
      node.children = node.children.filter((child) => {
        if (child.type === "element" && child.tagName === "iframe") {
          const src = typeof child.properties?.src === "string" ? (child.properties.src as string) : "";
          if (!isAllowedEmbedSrc(src)) return false;
        }
        walk(child);
        return true;
      });
    };
    walk(tree);
  };
}
