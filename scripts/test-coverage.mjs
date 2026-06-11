#!/usr/bin/env node
// Test coverage report by category. Scans the monorepo's test files, counts test cases, and
// overlap — one integration test can exercise an endpoint, the DB, permissions, and validation
// at once — so a test may count toward several categories. Run: `node scripts/test-coverage.mjs`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const TEST_RE = /\.(test|spec)\.(ts|tsx)$/;
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".turbo"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (TEST_RE.test(name)) out.push(p);
  }
  return out;
}

// Parse a file into test cases, tracking the nearest enclosing describe() title for context.
function parseTests(file) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const cases = [];
  let currentDescribe = "";
  const titleRe = /\b(?:it|test)\(\s*(["'`])((?:\\.|(?!\1).)*)\1/;
  const descRe = /\bdescribe\(\s*(["'`])((?:\\.|(?!\1).)*)\1/;
  for (const line of lines) {
    const d = descRe.exec(line);
    if (d) currentDescribe = d[2];
    const t = titleRe.exec(line);
    if (t) cases.push({ title: t[2], describe: currentDescribe });
  }
  return cases;
}

const rel = (f) => relative(ROOT, f).replaceAll("\\", "/");

const files = walk(join(ROOT, "apps")).map((f) => ({ path: rel(f), cases: parseTests(f) }));

// Helpers to classify.
const inDir = (f, frag) => f.path.includes(frag);
const isUnit = (f) => /\/src\/.*\.(test|spec)\.(ts|tsx)$/.test(f.path);
const isIntegration = (f) => inDir(f, "/test/integration/");
const isContract = (f) => inDir(f, "/test/contract/");
const isSecurityFile = (f) => inDir(f, "/test/security/");
const isE2E = (f) => inDir(f, "/e2e/") || f.path.endsWith("plugin-full-loop.test.ts");
const isAuthFile = (f) => /\/(auth|permissions\.[a-z]+|session)\.test\.ts$/.test(f.path);

const matches = (c, re) => re.test(`${c.describe} ${c.title}`);
const AUTH_RE = /permiss|auth|\brole\b|forbidden|unauthor|\btoken\b|admin-only|viewer|editor|manager|membership|bearer|session|csrf|existence|hidden|404/i;
const VALID_RE = /valid|invalid|\b400\b|\b404\b|\b409\b|\b403\b|require|missing|malformed|conflict|stale|rejects|bad request|duplicate|slug/i;
const SECURITY_RE = /idor|inject|leak|hygiene|rate.?limit|csrf|spoof|tamper|existence|hidden|nosniff|cross-workspace|clobber|escape|markup|xss/i;

// category -> predicate over (file, case). Counting is per test case.
const CATEGORIES = [
  { n: 1, name: "Unit (business logic)", pick: (f) => (isUnit(f) ? f.cases : []) },
  { n: 2, name: "API endpoint", pick: (f) => (isIntegration(f) && !f.path.endsWith("plugin-full-loop.test.ts") ? f.cases : []) },
  { n: 3, name: "Integration (database)", pick: (f) => (isIntegration(f) ? f.cases : []) },
  { n: 4, name: "Auth / permission", pick: (f) => (isAuthFile(f) ? f.cases : f.cases.filter((c) => matches(c, AUTH_RE))) },
  { n: 5, name: "Validation / error", pick: (f) => f.cases.filter((c) => matches(c, VALID_RE)) },
  { n: 6, name: "Contract", pick: (f) => (isContract(f) ? f.cases : []) },
  { n: 7, name: "Security", pick: (f) => (isSecurityFile(f) ? f.cases : f.cases.filter((c) => matches(c, SECURITY_RE))) },
  { n: 8, name: "End-to-end", pick: (f) => (isE2E(f) ? f.cases : []) },
];

const totalFiles = files.length;
const totalCases = files.reduce((a, f) => a + f.cases.length, 0);

const C = process.stdout.isTTY && !process.env.NO_COLOR;
const BOLD = C ? "\x1b[1m" : "", DIM = C ? "\x1b[2m" : "", GRN = C ? "\x1b[32m" : "", RED = C ? "\x1b[31m" : "", RST = C ? "\x1b[0m" : "";
const pad = (s, w) => String(s).padEnd(w);
const padN = (s, w) => String(s).padStart(w);

console.log(`\n${BOLD}Pageden — test coverage by category${RST}`);
console.log(`${DIM}${totalCases} test cases across ${totalFiles} files. Categories overlap.${RST}\n`);
console.log(`${BOLD}${pad("#", 3)}${pad("Category", 26)}${pad("Status", 9)}${padN("Tests", 6)}  ${padN("Files", 6)}  Where${RST}`);
console.log("─".repeat(96));

const rows = [];
for (const cat of CATEGORIES) {
  const contributing = files
    .map((f) => ({ file: f.path, hits: cat.pick(f).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  const tests = contributing.reduce((a, x) => a + x.hits, 0);
  const plain = tests > 0 ? "have" : "none";
  const status = `${tests > 0 ? GRN : RED}${pad(plain, 8)}${RST}`;
  const where = contributing.slice(0, 3).map((x) => `${x.file.split("/").pop()}(${x.hits})`).join(", ") + (contributing.length > 3 ? ", …" : "");
  rows.push({ cat, tests, fileCount: contributing.length, contributing });
  console.log(`${pad(cat.n, 3)}${pad(cat.name, 26)}${status} ${padN(tests, 6)}  ${padN(contributing.length, 6)}  ${DIM}${where}${RST}`);
}

console.log("─".repeat(96));
const covered = rows.filter((r) => r.tests > 0).length;
console.log(`${BOLD}${covered}/8 categories covered${RST}  ${DIM}(unique test cases: ${totalCases})${RST}\n`);

if (process.argv.includes("--files")) {
  for (const r of rows) {
    console.log(`${BOLD}${r.cat.n}. ${r.cat.name}${RST} — ${r.tests} tests`);
    for (const c of r.contributing) console.log(`   ${padN(c.hits, 4)}  ${c.file}`);
    console.log("");
  }
}

// Non-zero exit if any category has no coverage (useful as a CI gate).
const missing = rows.filter((r) => r.tests === 0).map((r) => r.cat.n);
if (missing.length) {
  console.log(`${RED}Missing coverage for categories: ${missing.join(", ")}${RST}`);
  process.exit(1);
}
