#!/usr/bin/env node
import process from "node:process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";

const API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const MODEL = process.env.OPENAI_MODEL || "gpt-5.2-codex";
const USER_QUERY = process.argv.slice(2).join(" ").trim() || "Validate this change.";

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

// Prefer staged diff → working tree diff → last commit diff
let diff = "";
try {
  diff = (await runGit(["diff", "--staged"])).trim();
  if (!diff) diff = (await runGit(["diff"])).trim();
  if (!diff) diff = (await runGit(["diff", "HEAD~1"])).trim();
} catch {
  // ignore
}

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

let fileContentsSections = "";
for (const f of changedFiles) {
  const content = await readFileContents(f);
  if (content !== null) {
    fileContentsSections += `\n=== FILE: ${f} ===\n${content}\n=== END: ${f} ===\n`;
  }
}

// --- Collect related/imported files for context ---
function extractImports(content) {
  const imports = [];
  // Match: import ... from './path' or require('./path')
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
  const content = await readFileContents(f);
  if (!content) continue;
  const dir = dirname(resolve(root, f));
  const imports = extractImports(content);

  for (const imp of imports) {
    const resolved = resolveImport(dir, imp);
    if (!resolved || seenRelated.has(resolved)) continue;
    seenRelated.add(resolved);
    const relContent = await readFileContents(resolved);
    if (relContent !== null) {
      relatedFilesSections += `\n=== RELATED FILE: ${resolved} ===\n${relContent}\n=== END: ${resolved} ===\n`;
    }
  }
}

const prompt = `You are a strict senior engineer reviewing a change.
Return ONLY valid JSON (no markdown).

User intent:
${USER_QUERY}

Repo context:
- branch: ${branch}
- changed_files: ${changedFiles.join(", ")}

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

const res = await fetch("https://api.openai.com/v1/responses", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: MODEL,
    input: prompt,
  }),
});

if (!res.ok) {
  const text = await res.text();
  console.error(text);
  process.exit(2);
}

const data = await res.json();

function extractText(r) {
  if (typeof r?.output_text === "string" && r.output_text.trim()) return r.output_text;
  const parts = [];
  for (const item of r?.output ?? []) {
    for (const c of item?.content ?? []) {
      if (c?.type === "output_text" && typeof c?.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n").trim() || JSON.stringify(r, null, 2);
}

process.stdout.write(extractText(data));
