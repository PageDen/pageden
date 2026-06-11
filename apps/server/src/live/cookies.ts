// Parse a raw HTTP Cookie header into a name->value map. Used by the live WebSocket route to
// read the pm_session cookie off the upgrade request (the cookie plugin's hook may not populate
// request.cookies for a WS upgrade). Kept dependency-free so it is trivially unit-tested.
export function parseCookieHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}
