// Media helpers for the editor: classify pasted URLs and normalize video providers.
// Pure functions (no DOM) so they are unit-tested directly.

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024; // mirrors the server's MAX_ATTACHMENT_BYTES

export type MediaKind = "image" | "video" | "embed" | null;

// SVG is intentionally excluded: it can carry active content and is served from our origin.
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i;
const VIDEO_EXT = /\.(mp4|webm|ogg|ogv|mov|m4v)$/i;
function validYouTubeId(id: string | undefined): id is string {
  return !!id && /^[A-Za-z0-9_-]{6,20}$/.test(id);
}

/** True for files we accept as uploads (images + common video containers). */
export function isUploadableType(mime: string): boolean {
  const m = mime.toLowerCase();
  if (m === "image/svg+xml") return false; // no inline SVG embeds
  return m.startsWith("image/") || m.startsWith("video/");
}

/** Convert a YouTube/Vimeo watch URL into its privacy-friendly iframe embed src, or null. */
export function normalizeEmbedUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.replace(/^www\./, "").toLowerCase();

  // YouTube: youtu.be/<id>, youtube.com/watch?v=<id>, /embed/<id>, /shorts/<id>
  if (host === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0];
    return validYouTubeId(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
    let id = u.searchParams.get("v") ?? "";
    if (!id) {
      const m = u.pathname.match(/^\/(?:embed|shorts)\/([^/?#]+)/);
      if (m?.[1]) id = m[1];
    }
    return validYouTubeId(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
  }

  // Vimeo: vimeo.com/<id> or player.vimeo.com/video/<id>
  if (host === "vimeo.com") {
    const id = u.pathname.split("/").filter(Boolean)[0];
    return id && /^\d+$/.test(id) ? `https://player.vimeo.com/video/${id}` : null;
  }
  if (host === "player.vimeo.com") {
    const m = u.pathname.match(/^\/video\/(\d+)/);
    return m ? `https://player.vimeo.com/video/${m[1]}` : null;
  }
  return null;
}

/** Classify a pasted/typed URL so the editor knows which node to insert. */
export function classifyMediaUrl(raw: string): MediaKind {
  if (normalizeEmbedUrl(raw)) return "embed";
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const path = u.pathname;
  if (IMAGE_EXT.test(path)) return "image";
  if (VIDEO_EXT.test(path)) return "video";
  return null;
}

/** Allowlisted iframe hosts for the sanitizer + render guards. */
export const ALLOWED_EMBED_HOSTS = ["www.youtube-nocookie.com", "player.vimeo.com"];

export function isAllowedEmbedSrc(src: string): boolean {
  try {
    const u = new URL(src);
    return u.protocol === "https:" && ALLOWED_EMBED_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}
