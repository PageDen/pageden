import { describe, it, expect } from "vitest";
import { normalizeEmbedUrl, classifyMediaUrl, isAllowedEmbedSrc, isUploadableType } from "./media.js";

describe("normalizeEmbedUrl", () => {
  it("handles YouTube watch / short / embed / youtu.be", () => {
    const expected = "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ";
    expect(normalizeEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(expected);
    expect(normalizeEmbedUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(expected);
    expect(normalizeEmbedUrl("https://youtube.com/shorts/dQw4w9WgXcQ")).toBe(expected);
    expect(normalizeEmbedUrl("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(expected);
  });
  it("handles Vimeo", () => {
    expect(normalizeEmbedUrl("https://vimeo.com/123456789")).toBe("https://player.vimeo.com/video/123456789");
    expect(normalizeEmbedUrl("https://player.vimeo.com/video/123456789")).toBe("https://player.vimeo.com/video/123456789");
  });
  it("rejects non-providers and bad input", () => {
    expect(normalizeEmbedUrl("https://example.com/watch?v=x")).toBeNull();
    expect(normalizeEmbedUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeEmbedUrl("not a url")).toBeNull();
    expect(normalizeEmbedUrl("https://vimeo.com/notnumeric")).toBeNull();
  });
});

describe("classifyMediaUrl", () => {
  it("detects images, videos, embeds", () => {
    expect(classifyMediaUrl("https://x.com/a.png")).toBe("image");
    expect(classifyMediaUrl("https://x.com/a.MP4")).toBe("video");
    expect(classifyMediaUrl("https://youtu.be/dQw4w9WgXcQ")).toBe("embed");
    expect(classifyMediaUrl("https://x.com/page")).toBeNull();
    expect(classifyMediaUrl("ftp://x.com/a.png")).toBeNull();
    expect(classifyMediaUrl("https://x.com/a.svg")).toBeNull();
  });
});

describe("isAllowedEmbedSrc", () => {
  it("only allows https youtube-nocookie / vimeo player", () => {
    expect(isAllowedEmbedSrc("https://www.youtube-nocookie.com/embed/x")).toBe(true);
    expect(isAllowedEmbedSrc("https://player.vimeo.com/video/1")).toBe(true);
    expect(isAllowedEmbedSrc("https://evil.com/embed/x")).toBe(false);
    expect(isAllowedEmbedSrc("http://www.youtube-nocookie.com/embed/x")).toBe(false);
  });
});

describe("isUploadableType", () => {
  it("accepts image/* and video/*", () => {
    expect(isUploadableType("image/png")).toBe(true);
    expect(isUploadableType("video/mp4")).toBe(true);
    expect(isUploadableType("application/pdf")).toBe(false);
    expect(isUploadableType("image/svg+xml")).toBe(false);
  });
});
