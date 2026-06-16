// Pre-process markdown so `:::decision` directive blocks render as a styled
// aside in the preview (ReactMarkdown with rehype-raw passes the inline HTML
// through). Keeps the server-side parser as the source of truth — this helper
// only mirrors enough to render: id / status / owner / date / decision / reason.

const FENCE_OPEN = /^:::decision\s*$/i;
const FENCE_CLOSE = /^:::\s*$/;

interface DecisionBlock {
  id?: string;
  status?: string;
  owner?: string;
  date?: string;
  replaces?: string;
  decision?: string;
  reason?: string;
}

function parseBlock(lines: string[]): DecisionBlock {
  const block: DecisionBlock = {};
  let inProse = false;
  const prose: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (Object.keys(block).length > 0) inProse = true;
      continue;
    }
    if (!inProse) {
      const headerMatch = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+)$/.exec(line);
      if (headerMatch) {
        const key = headerMatch[1]!.toLowerCase();
        const value = headerMatch[2]!.trim();
        if (key === "id") block.id = value;
        else if (key === "status") block.status = value;
        else if (key === "owner") block.owner = value;
        else if (key === "date") block.date = value;
        else if (key === "replaces") block.replaces = value;
        else if (key === "decision") {
          block.decision = value;
          inProse = true;
        }
        continue;
      }
    }
    const proseMatch = /^(decision|reason)\s*:\s*(.+)$/i.exec(line);
    if (proseMatch) {
      const key = proseMatch[1]!.toLowerCase() as "decision" | "reason";
      block[key] = proseMatch[2]!.trim();
      continue;
    }
    prose.push(line);
  }
  if (!block.decision && prose.length) block.decision = prose.join(" ");
  return block;
}

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STATUS_TONE: Record<string, string> = {
  accepted: "bg-emerald-100 text-emerald-800 ring-emerald-200",
  proposed: "bg-sky-100 text-sky-800 ring-sky-200",
  rejected: "bg-rose-100 text-rose-800 ring-rose-200",
  superseded: "bg-slate-100 text-slate-600 ring-slate-200",
};

function statusBadge(block: DecisionBlock): string {
  if (!block.status) return "";
  const tone = STATUS_TONE[block.status.toLowerCase()] ?? "bg-slate-100 text-slate-700 ring-slate-200";
  return `<span class="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ring-1 ${tone}">${escape(block.status)}</span>`;
}

function renderBlock(block: DecisionBlock): string {
  const header: string[] = [];
  if (block.id) header.push(`<span class="font-mono text-[11px] text-slate-500">${escape(block.id)}</span>`);
  if (block.status) header.push(statusBadge(block));
  const meta: string[] = [];
  if (block.owner) meta.push(`<span>owner: ${escape(block.owner)}</span>`);
  if (block.date) meta.push(`<span>${escape(block.date)}</span>`);
  if (block.replaces) meta.push(`<span>replaces: <span class="font-mono">${escape(block.replaces)}</span></span>`);
  const decisionLine = block.decision
    ? `<p class="mt-2 text-sm text-slate-900 dark:text-slate-100"><strong>Decision.</strong> ${escape(block.decision)}</p>`
    : "";
  const reasonLine = block.reason
    ? `<p class="mt-1 text-sm text-slate-700 dark:text-slate-300"><strong>Reason.</strong> ${escape(block.reason)}</p>`
    : "";
  return [
    `<aside class="decision-block not-prose my-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 dark:border-slate-700 dark:bg-slate-900/60">`,
    `<div class="flex flex-wrap items-center gap-2">${header.join("")}</div>`,
    meta.length ? `<div class="mt-1 flex flex-wrap gap-3 text-xs text-slate-500">${meta.join("")}</div>` : "",
    decisionLine,
    reasonLine,
    `</aside>`,
  ].join("");
}

/**
 * Walk the document body line-by-line; replace each :::decision … ::: fence
 * with an inline HTML aside. Non-decision content is returned unchanged.
 * When decisionsOnly is true, ALL non-decision content is dropped — only the
 * decision asides plus a small intro header are kept.
 */
export function renderDecisionBlocks(
  body: string,
  options: { decisionsOnly?: boolean } = {},
): { body: string; count: number } {
  const lines = body.split("\n");
  const out: string[] = [];
  let inside = false;
  let buffer: string[] = [];
  let count = 0;
  for (const line of lines) {
    if (!inside) {
      if (FENCE_OPEN.test(line.trim())) {
        inside = true;
        buffer = [];
        continue;
      }
      if (!options.decisionsOnly) out.push(line);
      continue;
    }
    if (FENCE_CLOSE.test(line.trim())) {
      const block = parseBlock(buffer);
      out.push(renderBlock(block));
      count++;
      inside = false;
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  if (options.decisionsOnly) {
    const intro = count
      ? `## Decisions (${count})\n\n`
      : `## Decisions\n\n_No structured \`:::decision\` blocks in this document._\n`;
    return { body: intro + out.join("\n"), count };
  }
  return { body: out.join("\n"), count };
}
