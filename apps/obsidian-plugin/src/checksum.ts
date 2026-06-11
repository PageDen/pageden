export function canonicalize(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n*$/, "") + "\n";
}

export async function checksum(content: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is required to compute Pageden checksums.");
  }
  const bytes = new TextEncoder().encode(canonicalize(content));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}
