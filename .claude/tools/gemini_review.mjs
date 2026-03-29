#!/usr/bin/env node
import process from "node:process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("Missing GEMINI_API_KEY");
  process.exit(1);
}

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-pro";
const USER_QUERY = process.argv.slice(2).join(" ").trim() || "Validate this change.";

// --- Size management ---
// ~4 chars per token; 200K chars ≈ 50K tokens, safe for large-context models
const MAX_PROMPT_CHARS = 200_000;
const MAX_FILE_CHARS = 30_000; // per-file cap (~500 lines)
const SKIP_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /\.min\.(js|css)$/,
  /\/dist\//,
  /\/node_modules\//,
  /\.map$/,
  /\.snap$/,
];

function shouldSkipFile(filePath) {
  return SKIP_PATTERNS.some((p) => p.test(filePath));
}

function truncateContent(content, label) {
  if (content.length <= MAX_FILE_CHARS) return content;
  return (
    content.slice(0, MAX_FILE_CHARS) +
    `\n... [${label} truncated at ${MAX_FILE_CHARS} chars] ...`
  );
}

async function runGit(args) {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    const p = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(err || `git ${args.join(" ")} failed (${code})`));
    });
  });
}

async function getRoot() {
  return (await runGit(["rev-parse", "--show-toplevel"])).trim();
}

// Prefer staged diff -> working tree diff -> last commit diff
let diff = "";
try {
  diff = (await runGit(["diff", "--staged"])).trim();
  if (!diff) diff = (await runGit(["diff"])).trim();
  if (!diff) diff = (await runGit(["diff", "HEAD~1"])).trim();
} catch {
  // ignore
}

// Truncate diff itself if massive
diff = truncateContent(diff, "diff");

// Collect changed files
let changedFiles = [];
let branch = "unknown";
try {
  const staged = (await runGit(["diff", "--name-only", "--staged"])).trim();
  const wt = (await runGit(["diff", "--name-only"])).trim();
  let all = staged + "\n" + wt;
  if (!staged && !wt) {
    all = (await runGit(["diff", "--name-only", "HEAD~1"])).trim();
  }
  changedFiles = [...new Set(all.split("\n").map((s) => s.trim()).filter(Boolean))];
} catch {
  // ignore
}
try {
  branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
} catch {
  // ignore
}

const root = await getRoot();

// --- Read full contents of changed files ---
async function readFileContents(filePath) {
  const abs = resolve(root, filePath);
  if (!existsSync(abs)) return null;
  try {
    return await readFile(abs, "utf-8");
  } catch {
    return null;
  }
}

// Track cumulative prompt size — start with estimated overhead for template + diff
let budgetUsed = diff.length + 1000;
const skippedFiles = [];

let fileContentsSections = "";
for (const f of changedFiles) {
  if (shouldSkipFile(f)) {
    skippedFiles.push(f);
    continue;
  }
  const content = await readFileContents(f);
  if (content === null) continue;
  const section = `\n=== FILE: ${f} ===\n${truncateContent(content, f)}\n=== END: ${f} ===\n`;
  if (budgetUsed + section.length > MAX_PROMPT_CHARS) {
    skippedFiles.push(f);
    continue;
  }
  budgetUsed += section.length;
  fileContentsSections += section;
}

// --- Collect related/imported files for context ---
function extractImports(content) {
  const imports = [];
  const regex = /(?:from|require\()\s*['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = regex.exec(content)) !== null) {
    imports.push(m[1]);
  }
  return imports;
}

function resolveImport(dir, imp) {
  const extensions = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs"];
  const indexFiles = ["/index.ts", "/index.tsx", "/index.js"];
  for (const ext of [...extensions, ...indexFiles]) {
    const candidate = resolve(dir, imp + ext);
    if (existsSync(candidate)) {
      return relative(root, candidate);
    }
  }
  return null;
}

const seenRelated = new Set(changedFiles);
let relatedFilesSections = "";

for (const f of changedFiles) {
  if (budgetUsed >= MAX_PROMPT_CHARS) break;
  const content = await readFileContents(f);
  if (!content) continue;
  const dir = dirname(resolve(root, f));
  const imports = extractImports(content);

  for (const imp of imports) {
    const resolved = resolveImport(dir, imp);
    if (!resolved || seenRelated.has(resolved)) continue;
    seenRelated.add(resolved);
    if (shouldSkipFile(resolved)) continue;
    const relContent = await readFileContents(resolved);
    if (relContent === null) continue;
    const section = `\n=== RELATED FILE: ${resolved} ===\n${truncateContent(relContent, resolved)}\n=== END: ${resolved} ===\n`;
    if (budgetUsed + section.length > MAX_PROMPT_CHARS) {
      skippedFiles.push(resolved);
      continue;
    }
    budgetUsed += section.length;
    relatedFilesSections += section;
  }
}

const skippedNote =
  skippedFiles.length > 0
    ? `\n(${skippedFiles.length} file(s) skipped to stay within context limits: ${skippedFiles.join(", ")})\n`
    : "";

const prompt = `You are a strict senior engineer reviewing a change.
Return ONLY valid JSON (no markdown, no code fences).

User intent:
${USER_QUERY}

Repo context:
- branch: ${branch}
- changed_files: ${changedFiles.join(", ")}
${skippedNote}
== DIFF (summary of what changed) ==
${diff}

== FULL CONTENTS OF CHANGED FILES ==
${fileContentsSections || "No file contents available."}

== RELATED FILES (imports/dependencies of changed files, for context) ==
${relatedFilesSections || "No related files found."}

Output JSON schema:
{
  "summary": "1-2 sentences",
  "verdict": "approve|approve_with_nits|needs_changes|block",
  "issues": [
    {
      "severity": "blocker|major|minor|nit",
      "title": "short",
      "file": "path or null",
      "line": "number or null",
      "explanation": "why it matters",
      "suggested_fix": "concrete fix"
    }
  ],
  "recommended_tests": ["..."]
}
`;

const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
    },
  }),
});

if (!res.ok) {
  const text = await res.text();
  console.error(text);
  process.exit(2);
}

const data = await res.json();

// Extract text from Gemini API response
const parts = data?.candidates?.[0]?.content?.parts ?? [];
const text = parts.map((p) => p.text ?? "").join("").trim();

if (!text) {
  console.error("No response text from Gemini");
  console.error(JSON.stringify(data, null, 2));
  process.exit(3);
}

process.stdout.write(text);
