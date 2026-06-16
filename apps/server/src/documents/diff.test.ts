import { describe, expect, it } from "vitest";
import { documentDiffFor } from "./diff.js";

// The DB-bound path is covered in test/integration/doc-stats-diff.test.ts;
// this unit test just locks in the cheap "same revision" guard so a regression
// can't silently make us run an LCS walk over identical inputs.
describe("documentDiffFor", () => {
  it("reports same_version when fromVersion === toVersion (no DB call needed)", async () => {
    const out = await documentDiffFor("doc1", "vX", "vX");
    expect("error" in out && out.error === "same_version").toBe(true);
  });
});
