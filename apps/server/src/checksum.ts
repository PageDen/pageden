import { createHash } from "node:crypto";

// Canonical form (review H3): UTF-8, LF newlines, exactly one trailing LF.
// Server, web app, and plugin must all hash this identical form.
export function canonicalize(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n*$/, "") + "\n";
}

export function checksum(content: string): string {
  const digest = createHash("sha256").update(canonicalize(content), "utf8").digest("hex");
  return `sha256:${digest}`;
}
