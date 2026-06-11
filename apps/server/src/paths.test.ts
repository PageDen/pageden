import { describe, it, expect } from "vitest";
import { buildDocumentPath, buildFolderPath, isValidSlug, rerootPath } from "./paths.js";

describe("slug validation", () => {
  it("accepts lowercase, digits, and hyphens", () => {
    expect(isValidSlug("deploy-runbook")).toBe(true);
    expect(isValidSlug("v2")).toBe(true);
  });
  it("rejects spaces, capitals, and edge hyphens", () => {
    expect(isValidSlug("Deploy")).toBe(false);
    expect(isValidSlug("a b")).toBe(false);
    expect(isValidSlug("-x")).toBe(false);
    expect(isValidSlug("x-")).toBe(false);
    expect(isValidSlug("")).toBe(false);
  });
});

describe("path building", () => {
  it("builds folder and document paths", () => {
    expect(buildFolderPath(null, "engineering")).toBe("engineering");
    expect(buildFolderPath("engineering", "ops")).toBe("engineering/ops");
    expect(buildDocumentPath("engineering", "deploy")).toBe("engineering/deploy.md");
    expect(buildDocumentPath("", "readme")).toBe("readme.md");
  });
});

describe("rerootPath", () => {
  it("re-roots the folder itself and descendants", () => {
    expect(rerootPath("engineering", "engineering", "ops")).toBe("ops");
    expect(rerootPath("engineering/deploy.md", "engineering", "ops")).toBe("ops/deploy.md");
    expect(rerootPath("engineering/sub/x.md", "engineering", "platform/ops")).toBe("platform/ops/sub/x.md");
  });
  it("leaves unrelated paths untouched", () => {
    expect(rerootPath("product/roadmap.md", "engineering", "ops")).toBe("product/roadmap.md");
  });
});
