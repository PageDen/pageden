import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");

describe("document view styles", () => {
  it("renders headings with view-mode hierarchy", () => {
    expect(css).toMatch(/\.pageden-document-view\.prose h1\s*{[^}]*text-4xl[^}]*font-semibold/s);
    expect(css).toMatch(/\.pageden-document-view\.prose h2\s*{[^}]*text-3xl[^}]*font-semibold/s);
    expect(css).toMatch(/\.pageden-document-view\.prose h3\s*{[^}]*text-2xl[^}]*font-semibold/s);
  });

  it("renders list markers in view mode", () => {
    expect(css).toMatch(/\.pageden-document-view\.prose ul\s*{[^}]*list-disc/s);
    expect(css).toMatch(/\.pageden-document-view\.prose ol\s*{[^}]*list-decimal/s);
  });
});
