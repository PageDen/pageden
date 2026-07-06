import { extractDecisions, type Decision } from "./handoff.js";
import { findRange, replaceSection, sectionRanges } from "./sections.js";

export class DecisionWriteError extends Error {
  constructor(
    public readonly code: "invalid_decision" | "duplicate_decision",
    message: string,
    public readonly fields: Record<string, string> = {},
  ) {
    super(message);
    this.name = "DecisionWriteError";
  }
}

export interface DecisionInput {
  id: string;
  status: string;
  owner: string;
  decision: string;
  reason: string;
  replaces?: string | null;
}

export function addDecisionToContent(body: string, input: DecisionInput): { body: string; decision: Decision; sectionAnchor: string } {
  const normalized = normalizeDecisionInput(input);
  const duplicate = extractDecisions(body).find((decision) => decision.id === normalized.id);
  if (duplicate) {
    throw new DecisionWriteError("duplicate_decision", `Decision id '${normalized.id}' already exists.`);
  }

  const block = decisionBlock(normalized);
  const ranges = sectionRanges(body);
  const decisions = findRange(ranges, "decisions");
  if (decisions) {
    const currentSection = body.split("\n").slice(decisions.contentStart, decisions.contentEnd).join("\n").trimEnd();
    const nextSection = `${currentSection}${currentSection ? "\n\n" : ""}${block}`;
    const spliced = replaceSection(body, decisions.anchor, nextSection);
    if (spliced) return { body: spliced.body, decision: normalized, sectionAnchor: spliced.anchor };
  }

  const trimmed = body.trimEnd();
  const nextBody = `${trimmed}${trimmed ? "\n\n" : ""}## Decisions\n\n${block}\n`;
  return { body: nextBody, decision: normalized, sectionAnchor: "decisions" };
}

function normalizeDecisionInput(input: DecisionInput): Decision {
  const id = cleanHeader("id", input.id);
  const status = cleanHeader("status", input.status);
  const owner = cleanHeader("owner", input.owner);
  const replaces = input.replaces === null || input.replaces === undefined || input.replaces.trim() === "" ? null : cleanHeader("replaces", input.replaces);
  const decision = cleanBody("decision", input.decision);
  const reason = cleanBody("reason", input.reason);
  const fields: Record<string, string> = {};
  if (!id) fields.id = "id is required.";
  if (id && !/^[A-Za-z0-9][A-Za-z0-9._-]{1,119}$/.test(id)) fields.id = "id must be 2-120 characters using letters, numbers, dots, underscores, or hyphens.";
  if (!status) fields.status = "status is required.";
  if (!owner) fields.owner = "owner is required.";
  if (!decision) fields.decision = "decision is required.";
  if (!reason) fields.reason = "reason is required.";
  if (Object.keys(fields).length > 0) throw new DecisionWriteError("invalid_decision", "Decision fields are invalid.", fields);
  return { id, status, date: null, owner, replaces, decision, reason };
}

function cleanHeader(_field: string, value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function cleanBody(_field: string, value: string): string {
  return value.trim().replace(/\r\n?/g, "\n");
}

function decisionBlock(decision: Decision): string {
  return [
    ":::decision",
    `id: ${decision.id}`,
    `status: ${decision.status}`,
    `owner: ${decision.owner ?? ""}`,
    ...(decision.replaces ? [`replaces: ${decision.replaces}`] : []),
    "",
    `decision: ${decision.decision}`,
    `reason: ${decision.reason}`,
    ":::",
  ].join("\n");
}
