export interface ParsedFrontmatter {
  attributes: Record<string, string | string[] | boolean | number>;
  body: string;
  raw: string | null;
}

export function parseFrontmatter(markdown: string): ParsedFrontmatter {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    return { attributes: {}, body: markdown, raw: null };
  }

  const newline = markdown.startsWith("---\r\n") ? "\r\n" : "\n";
  const marker = `${newline}---${newline}`;
  const end = markdown.indexOf(marker, 3);
  if (end === -1) return { attributes: {}, body: markdown, raw: null };

  const raw = markdown.slice(3 + newline.length, end);
  const body = markdown.slice(end + marker.length);
  return { attributes: parseYamlishAttributes(raw), body, raw };
}

export function frontmatterTitle(markdown: string): string | null {
  const title = parseFrontmatter(markdown).attributes.title;
  return typeof title === "string" && title.trim() ? title.trim() : null;
}

function parseYamlishAttributes(raw: string): ParsedFrontmatter["attributes"] {
  const attributes: ParsedFrontmatter["attributes"] = {};
  const lines = raw.split(/\r?\n/);
  let currentKey: string | null = null;
  for (const line of lines) {
    const listItem = line.match(/^\s*-\s+(.+)$/);
    if (currentKey && listItem) {
      const existing = attributes[currentKey];
      attributes[currentKey] = [...(Array.isArray(existing) ? existing : []), cleanScalar(listItem[1] ?? "")];
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      currentKey = null;
      continue;
    }

    const key = match[1]!;
    const value = match[2] ?? "";
    currentKey = key;
    attributes[key] = parseValue(value);
  }
  return attributes;
}

function parseValue(value: string): string | string[] | boolean | number {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map(cleanScalar)
      .filter(Boolean);
  }
  return cleanScalar(trimmed);
}

function cleanScalar(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}
