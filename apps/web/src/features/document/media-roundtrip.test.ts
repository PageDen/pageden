import { describe, it, expect } from "vitest";
import { markdownToHtml, htmlToMarkdown, joinMarkdownFrontmatter, splitMarkdownFrontmatter } from "./rich-markdown-editor";

describe("media markdown round-trip", () => {
  it("keeps an uploaded <video> through html<->markdown", () => {
    const md = '<video controls src="https://go.pageden.app/api/attachments/abc"></video>\n';
    const html = markdownToHtml(md);
    expect(html).toContain("<video");
    expect(htmlToMarkdown(html)).toContain('<video');
    expect(htmlToMarkdown(html)).toContain("api/attachments/abc");
  });

  it("keeps a YouTube <iframe> through html<->markdown", () => {
    const md = '<iframe src="https://www.youtube-nocookie.com/embed/abc"></iframe>\n';
    const html = markdownToHtml(md);
    expect(html).toContain("<iframe");
    const back = htmlToMarkdown(html);
    expect(back).toContain("<iframe");
    expect(back).toContain("youtube-nocookie.com/embed/abc");
  });

  it("keeps images as Markdown image syntax", () => {
    const html = markdownToHtml("![alt](https://x.com/a.png)\n");
    expect(htmlToMarkdown(html)).toContain("![alt](https://x.com/a.png)");
  });

  it("keeps image layout attributes when the image was resized or aligned", () => {
    const html = '<p><img src="https://x.com/a.png" alt="a" width="640" height="360" data-align="right"></p>';
    const back = htmlToMarkdown(html);
    expect(back).toContain("<img");
    expect(back).toContain('src="https://x.com/a.png"');
    expect(back).toContain('width="640"');
    expect(back).toContain('height="360"');
    expect(back).toContain('data-align="right"');
  });

  it("keeps YAML frontmatter out of the rendered editor body", () => {
    const md = [
      "---",
      "status: canonical",
      "docType: reference",
      "created: 2026-06-17",
      "---",
      "",
      "# AI Agent Onboarding",
      "",
      "1. There are **two repos**.",
      "2. Work happens on `PageDen/pageden`.",
      "",
    ].join("\n");
    const parts = splitMarkdownFrontmatter(md);
    const html = markdownToHtml(parts.body);
    const back = joinMarkdownFrontmatter(parts.frontmatter, htmlToMarkdown(html));

    expect(html).not.toContain("<hr");
    expect(html).not.toContain("status: canonical");
    expect(back).toMatch(/^---\nstatus: canonical\ndocType: reference\ncreated: 2026-06-17\n---\n\n# AI Agent Onboarding/);
    expect(back).toMatch(/1\.\s+There are \*\*two repos\*\*\./);
    expect(back).toMatch(/2\.\s+Work happens on `PageDen\/pageden`\./);
  });
});
