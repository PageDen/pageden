// Implementation readiness + task packet derivation for the Phase 2 agent handoff
// flow. We keep this orthogonal to `aiReadiness` (which scores "is this doc
// well-written for an agent to read?") because the handoff question is different:
// "given the canonical/superseded status and the way phases/criteria are written,
// is this safe to start implementing from?". Both can run independently; both are
// surfaced through MCP and through the document read endpoint.

import { documentContext, type DocumentContext } from "../ai-readiness.js";
import type { DocumentStatus } from "@prisma/client";
import { dedupeDecisions, maskCodeContext } from "./markdown-context.js";

export type ImplementationReadinessStatus =
  | "ready_to_implement"
  | "needs_contract_update"
  | "has_blocking_questions"
  | "conflicting_guidance"
  | "draft_only"
  | "superseded";

export interface ImplementationReadinessReason {
  code: string;
  severity: "blocking" | "warning" | "info";
  message: string;
}

export interface ImplementationReadiness {
  status: ImplementationReadinessStatus;
  score: number;
  reasons: ImplementationReadinessReason[];
}

export interface ReadinessComment {
  id?: string;
  body: string;
  sectionAnchor?: string | null;
}

export interface DocumentSection {
  heading: string;
  anchor: string;
  level: number;
  content: string;
}

export interface Decision {
  id: string;
  status: string;
  date: string | null;
  owner: string | null;
  replaces: string | null;
  decision: string;
  reason: string;
}

export interface TaskPacket {
  summary: string;
  status: DocumentStatus;
  supersededBy: { id: string; title: string; path: string } | null;
  currentPhase: string | null;
  nextSteps: string[];
  acceptanceCriteria: string[];
  tests: string[];
  nonGoals: string[];
  openQuestions: string[];
  relatedFiles: string[];
  decisions: Decision[];
  prLinks: string[];
  implementationReadiness: ImplementationReadiness;
}

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const DECISION_FENCE_OPEN = /^:::\s*decision\s*$/i;
const DECISION_FENCE_CLOSE = /^:::\s*$/;
const PR_LINK_RE = /https?:\/\/(?:[\w-]+\.)*github\.com\/[\w./-]+\/(?:pull|issues)\/\d+|https?:\/\/(?:[\w-]+\.)*gitlab\.com\/[\w./-]+\/(?:-\/)?(?:merge_requests|issues)\/\d+/g;

// Parse ::: decision … ::: fence blocks into structured records so an agent can
// list canonical decisions without re-reading the whole document. Lines inside
// the fence are split into a YAML-ish header and free-form prose; the prose is
// further split into `decision:` and `reason:` lines when present so the
// agent does not have to do that parsing itself.
export function extractDecisions(body: string): Decision[] {
  // Feature 17: skip :::decision blocks that appear inside markdown code
  // fences (illustrative examples); dedupe the survivors by id so a leaked
  // example cannot overwrite the real list. Pre-masking happens before our
  // own fence detection so the body view a decision parser sees is "real
  // content only".
  const masked = maskCodeContext(body);
  const lines = masked.body.split("\n");
  const decisions: Decision[] = [];
  let inside = false;
  let buffer: string[] = [];
  for (const line of lines) {
    if (!inside) {
      if (DECISION_FENCE_OPEN.test(line.trim())) {
        inside = true;
        buffer = [];
      }
      continue;
    }
    if (DECISION_FENCE_CLOSE.test(line.trim())) {
      const decision = parseDecisionBlock(buffer);
      if (decision) decisions.push(decision);
      inside = false;
      buffer = [];
      continue;
    }
    buffer.push(line);
  }
  return dedupeDecisions(decisions);
}

function parseDecisionBlock(lines: string[]): Decision | null {
  const header: Record<string, string> = {};
  const prose: string[] = [];
  let inProse = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!inProse) {
      const trimmed = line.trim();
      if (!trimmed) {
        inProse = true;
        continue;
      }
      const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(trimmed);
      if (match) {
        header[match[1]!.toLowerCase()] = match[2]!.trim();
        continue;
      }
      // First non-header, non-blank line ends the header section.
      inProse = true;
      prose.push(line);
      continue;
    }
    prose.push(line);
  }
  const id = header.id ?? "";
  if (!id) return null;
  const proseText = prose.join("\n").trim();
  const decisionLine = /^decision:\s*(.+)$/im.exec(proseText)?.[1]?.trim() ?? "";
  const reasonLine = /^reason:\s*(.+)$/im.exec(proseText)?.[1]?.trim() ?? "";
  return {
    id,
    status: header.status ?? "unspecified",
    date: header.date ?? null,
    owner: header.owner ?? null,
    replaces: header.replaces ?? null,
    decision: decisionLine || proseText,
    reason: reasonLine,
  };
}

// Pull github/gitlab pull-request and issue links out of the frontmatter and body
// so the handoff packet can show "this doc → PR #123 in repo X" without an agent
// having to grep for them.
export function extractPrLinks(body: string, frontmatter: Record<string, string | string[]>): string[] {
  const found = new Set<string>();
  const fmRaw = frontmatter.prLinks;
  if (Array.isArray(fmRaw)) {
    for (const value of fmRaw) {
      if (typeof value === "string") found.add(value.trim());
    }
  } else if (typeof fmRaw === "string") {
    found.add(fmRaw.trim());
  }
  for (const match of body.matchAll(PR_LINK_RE)) found.add(match[0]);
  return [...found].filter((value) => value.length > 0 && value.length <= 512).slice(0, 30);
}

// Split the body into a flat ordered list of sections. Each section's `content`
// is the text from the line after its heading up to the next heading line — so
// we can address one section by anchor for `pageden_read_section` without
// loading the whole document into an agent context window.
export function extractSections(body: string): DocumentSection[] {
  const lines = body.split("\n");
  const starts: Array<{ heading: string; anchor: string; level: number; startLine: number }> = [];
  lines.forEach((line, i) => {
    const match = HEADING_RE.exec(line);
    if (!match) return;
    const level = match[1]!.length;
    const heading = match[2]!.replace(/\s+#+$/, "").trim();
    if (!heading) return;
    starts.push({ heading, anchor: anchorFor(heading), level, startLine: i });
  });
  return starts.map((section, idx) => {
    const startLine = section.startLine + 1;
    const endLine = starts[idx + 1]?.startLine ?? lines.length;
    return {
      heading: section.heading,
      anchor: section.anchor,
      level: section.level,
      content: lines.slice(startLine, endLine).join("\n").trim(),
    };
  });
}

export function findSection(sections: DocumentSection[], needle: string): DocumentSection | null {
  const target = needle.trim().toLowerCase();
  if (!target) return null;
  // Exact-anchor match wins (stable); fall back to case-insensitive heading match
  // so agents can pass either the slug or the human title without remembering which.
  return (
    sections.find((section) => section.anchor === target) ??
    sections.find((section) => section.heading.toLowerCase() === target) ??
    null
  );
}

// Implementation readiness uses the document content + canonical status to answer
// "can an agent safely start coding from this?". Order matters: superseded short-
// circuits everything else; blocking questions outweigh missing contract notes.
export function implementationReadinessFor({
  status,
  context,
  comments = [],
}: {
  status: DocumentStatus;
  context: DocumentContext;
  comments?: ReadinessComment[];
}): ImplementationReadiness {
  const reasons: ImplementationReadinessReason[] = [];
  if (status === "superseded") {
    return {
      status: "superseded",
      score: 0,
      reasons: [
        {
          code: "superseded",
          severity: "blocking",
          message: "This document has been superseded; implement from the replacement instead.",
        },
      ],
    };
  }
  if (status === "draft") {
    reasons.push({
      code: "status_draft",
      severity: "warning",
      message: "Document is marked as draft. Promote it to canonical before relying on it.",
    });
  }
  if (status === "archived") {
    return {
      status: "draft_only",
      score: 0,
      reasons: [
        {
          code: "status_archived",
          severity: "blocking",
          message: "Archived documents are excluded from implementation.",
        },
      ],
    };
  }

  const sections = extractSections(context.body);
  const hasSection = (re: RegExp): boolean => sections.some((section) => re.test(section.heading));
  const sectionContent = (re: RegExp): string | null =>
    sections.find((section) => re.test(section.heading))?.content ?? null;

  const acceptanceCriteria = collectBullets(sectionContent(SECTION_PATTERNS.acceptance));
  const tests = collectBullets(sectionContent(SECTION_PATTERNS.tests));
  const nonGoals = collectBullets(sectionContent(SECTION_PATTERNS.nonGoals));
  const openQuestions = collectBullets(sectionContent(SECTION_PATTERNS.openQuestions));
  const nextPrScope = collectBullets(sectionContent(SECTION_PATTERNS.nextPrScope));

  if (!acceptanceCriteria.length && !hasSection(SECTION_PATTERNS.acceptance)) {
    reasons.push({
      code: "missing_acceptance_criteria",
      severity: "warning",
      message: "Add a Definition of Done or Acceptance Criteria section before implementing.",
    });
  }
  if (!tests.length && !hasSection(SECTION_PATTERNS.tests)) {
    reasons.push({
      code: "missing_test_plan",
      severity: "info",
      message: "No Tests / Test Plan section was found.",
    });
  }
  if (!nonGoals.length) {
    reasons.push({
      code: "missing_non_goals",
      severity: "info",
      message: "Non-goals are unstated — agents may overreach scope.",
    });
  }
  if (hasContractRequirement(context, sections) && !hasContractConfirmation(context, sections)) {
    reasons.push({
      code: "contract_update_needed",
      severity: "warning",
      message: "Document mentions API contract changes — confirm the api-contract is updated before merging.",
    });
  }
  if (!nextPrScope.length && !hasSection(SECTION_PATTERNS.nextPrScope)) {
    reasons.push({
      code: "missing_next_pr_scope",
      severity: "warning",
      message: "Add a Next PR Scope section so the first implementation pull request is clear.",
    });
  }

  const blockingQuestions = openQuestions.filter((q) => /\bblock(?:ing|s|er)\b/i.test(q));
  if (blockingQuestions.length) {
    reasons.unshift({
      code: "blocking_questions",
      severity: "blocking",
      message: `${blockingQuestions.length} blocking question${blockingQuestions.length === 1 ? "" : "s"} must be resolved first.`,
    });
  } else if (openQuestions.length) {
    reasons.push({
      code: "open_questions",
      severity: "info",
      message: `${openQuestions.length} open question${openQuestions.length === 1 ? "" : "s"} — non-blocking but worth a read.`,
    });
  }

  if (hasConflictingGuidance(context, sections)) {
    reasons.push({
      code: "conflicting_guidance",
      severity: "warning",
      message: "Document mentions conflicting or duplicate guidance with another doc.",
    });
  }

  for (const comment of comments) {
    const body = comment.body.trim();
    if (!body) continue;
    if (/conflicts? with|conflicting|inconsistent/i.test(body)) {
      reasons.push({
        code: "unresolved_conflict_comment",
        severity: "warning",
        message: "An unresolved section comment flags conflicting guidance.",
      });
      continue;
    }
    if (/needs? api contract update|api[- ]?contract/i.test(body)) {
      reasons.push({
        code: "unresolved_contract_comment",
        severity: "warning",
        message: "An unresolved section comment asks for an API contract update.",
      });
      continue;
    }
    if (/ready for implementation/i.test(body)) {
      reasons.push({
        code: "ready_comment_present",
        severity: "info",
        message: "A reviewer comment says this is ready for implementation.",
      });
    }
  }

  // Status precedence: blocking > conflicting > contract-update > draft > ready.
  const blocking = reasons.some((r) => r.severity === "blocking");
  if (blocking) {
    return { status: "has_blocking_questions", score: readinessScore(status, reasons), reasons };
  }
  if (reasons.some((r) => r.code === "conflicting_guidance" || r.code === "unresolved_conflict_comment")) {
    return { status: "conflicting_guidance", score: readinessScore(status, reasons), reasons };
  }
  if (reasons.some((r) => r.code === "contract_update_needed" || r.code === "unresolved_contract_comment")) {
    return { status: "needs_contract_update", score: readinessScore(status, reasons), reasons };
  }
  if (status === "draft") return { status: "draft_only", score: readinessScore(status, reasons), reasons };
  return { status: "ready_to_implement", score: readinessScore(status, reasons), reasons };
}

const SECTION_PATTERNS = {
  summary: /^(summary|goal|why|context|tl;?dr|overview)\b/i,
  acceptance: /^(acceptance criteria|definition of done|dod|done when|success criteria)/i,
  tests: /^(tests?|test plan|testing|test checklist|qa)/i,
  nonGoals: /^(non[- ]goals?|out of scope|will not|won['']t do)/i,
  openQuestions: /^(open questions?|questions?|blocking questions?|unresolved)/i,
  nextPrScope: /^(next pr scope|pr scope|first pr scope|first pull request|next pull request)/i,
  nextSteps: /^(next steps?|next action|first pr|implementation steps?|plan|phases?)/i,
  currentPhase: /^(current phase|phase \d|status:?)\b/i,
  decisions: /^(decisions?|decision log|history of decisions)/i,
  related: /^(related|references?|see also|prior art|links?)/i,
} as const;

export function taskPacketFor({
  status,
  supersededBy,
  context,
  comments,
}: {
  status: DocumentStatus;
  supersededBy: TaskPacket["supersededBy"];
  context: DocumentContext;
  comments?: ReadinessComment[];
}): TaskPacket {
  const sections = extractSections(context.body);
  const sectionByPattern = (re: RegExp): DocumentSection | null =>
    sections.find((section) => re.test(section.heading)) ?? null;
  const summary = sectionByPattern(SECTION_PATTERNS.summary)?.content ?? firstParagraph(context.body);
  const currentPhaseSection = sections.find((s) => /^phase\s*\d/i.test(s.heading));
  const nextStepsSection = sectionByPattern(SECTION_PATTERNS.nextSteps);
  const acceptance = sectionByPattern(SECTION_PATTERNS.acceptance);
  const tests = sectionByPattern(SECTION_PATTERNS.tests);
  const nonGoals = sectionByPattern(SECTION_PATTERNS.nonGoals);
  const openQ = sectionByPattern(SECTION_PATTERNS.openQuestions);

  return {
    summary: condense(summary, 480),
    status,
    supersededBy,
    currentPhase: currentPhaseSection?.heading ?? null,
    nextSteps: collectBullets(nextStepsSection?.content),
    acceptanceCriteria: collectBullets(acceptance?.content),
    tests: collectBullets(tests?.content),
    nonGoals: collectBullets(nonGoals?.content),
    openQuestions: collectBullets(openQ?.content),
    relatedFiles: extractRelatedFiles(context.body),
    decisions: extractDecisions(context.body),
    prLinks: extractPrLinks(context.body, context.frontmatter),
    implementationReadiness: implementationReadinessFor({ status, context, comments }),
  };
}

// Public re-export so the route layer can call documentContext without importing
// from two files when it already imports the handoff helpers.
export { documentContext };

function firstParagraph(body: string): string {
  // Walk paragraphs, skipping leading headings so a typical "# Title\n\nFirst
  // sentence describes the goal." pattern returns the prose, not the heading.
  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  for (const paragraph of paragraphs) {
    if (HEADING_RE.test(paragraph)) continue;
    return condense(paragraph, 480);
  }
  return "";
}

function collectBullets(content: string | null | undefined): string[] {
  if (!content) return [];
  const items: string[] = [];
  for (const line of content.split("\n")) {
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (bullet) {
      const text = bullet[1]!.trim();
      if (text) items.push(text);
    }
  }
  return items;
}

// Identify code-y references that look like source file paths (e.g.
// "apps/server/src/documents/routes.ts") so the packet can hint at where the
// implementation likely lives without us indexing every reference.
function extractRelatedFiles(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(/`([^`]+\.(?:ts|tsx|js|jsx|sql|prisma|json|yml|yaml))`/g)) {
    found.add(match[1]!.trim());
  }
  for (const match of body.matchAll(/(?:^|[\s(])((?:apps|packages|src)\/[\w./@-]+\.(?:ts|tsx|js|jsx|sql|prisma|json|yml|yaml))/g)) {
    found.add(match[1]!.trim());
  }
  return [...found].sort().slice(0, 20);
}

function hasContractRequirement(context: DocumentContext, sections: DocumentSection[]): boolean {
  const text = sections.map((s) => `${s.heading}\n${s.content}`).join("\n");
  return /api[- ]?contract|endpoint|schema (?:change|update)/i.test(text) || Boolean(context.frontmatter.contract);
}

function hasContractConfirmation(context: DocumentContext, sections: DocumentSection[]): boolean {
  const value = context.frontmatter.apiContractUpdated ?? context.frontmatter.contractUpdated;
  if (typeof value === "string" && /^(true|yes|done|not required|n\/a)$/i.test(value.trim())) return true;
  if (Array.isArray(value) && value.some((item) => /^(true|yes|done|not required|n\/a)$/i.test(item.trim()))) return true;
  const text = sections.map((s) => `${s.heading}\n${s.content}`).join("\n");
  return /api[- ]?contract (?:updated|done|confirmed|not required|not needed|unchanged|no change)/i.test(text);
}

function hasConflictingGuidance(context: DocumentContext, sections: DocumentSection[]): boolean {
  const text = sections.map((s) => s.content).join("\n");
  if (/conflicting|conflicts with|inconsistent|outdated guidance/i.test(text)) return true;
  return Boolean(context.frontmatter.conflictsWith);
}

function condense(value: string, max: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function readinessScore(status: DocumentStatus, reasons: ImplementationReadinessReason[]): number {
  if (status === "superseded" || status === "archived") return 0;
  let score = 100;
  for (const reason of reasons) {
    score -= reason.severity === "blocking" ? 35 : reason.severity === "warning" ? 15 : 5;
  }
  if (status === "draft") score = Math.min(score, 70);
  return Math.max(0, Math.min(100, score));
}

function anchorFor(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_~[\]().,!?;:'"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
