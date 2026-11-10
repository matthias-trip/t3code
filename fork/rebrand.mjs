#!/usr/bin/env node
// Rebrands an upstream T3 Code tree to "Claude Code": the names a person sees
// (app name, bundle ID, window and UI text, installer file names). Internal
// names, environment variables, protocols, MCP definitions and agent-facing
// text stay as upstream has them. Deterministic and idempotent, so the daily
// sync replays it on every upstream release instead of hand-merging renames.
//
// Usage: node fork/rebrand.mjs [tree-root] [release-version]
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".."));
const MAX_BYTES = 8 * 1024 * 1024;

// The interface itself: every rule applies, including the bare word "T3".
const INTERFACE = [
  /^apps\/web\//,
  /^apps\/desktop\//,
  /^apps\/server\/src\/cli\//,
  /^packages\/(?:shared|client-runtime)\/src\//,
  /^scripts\/build-desktop-artifact(?:\.test)?\.ts$/,
];
// Server and provider code, whose status and error messages reach the
// interface: only the product names change.
const MESSAGES = [/^apps\/server\/src\//, /^packages\/[^/]+\/src\//];
// Text written for agents and other programs, not for people. The web and
// desktop apps are exempt: their files with these names are screens.
const AGENT_FACING = [/mcp/i, /instructions/i, /prompt/i, /textGeneration/i, /pullRequestWatch/i, /testkit/];
const NEVER = [/\/fixtures\//, /\.snap$/];

function rulesFor(file) {
  if (NEVER.some((pattern) => pattern.test(file))) return null;
  const screen = /^apps\/(?:web|desktop)\//.test(file);
  if (!screen && AGENT_FACING.some((pattern) => pattern.test(file))) return null;
  if (INTERFACE.some((pattern) => pattern.test(file))) return RULES;
  if (MESSAGES.some((pattern) => pattern.test(file))) return PRODUCT_RULES;
  return null;
}

// Left alone even inside user-facing files.
const PROTECTED = [
  /[A-Za-z0-9.-]*t3\.(?:codes|chat|gg)\b[^\s"'`)]*/g,
  /github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+[^\s"'`)]*/g,
  /T3[ -]?Chat/gi,
  // Profile directories of earlier upstream versions, read for migration.
  /(?:legacy: |PROFILE_NAMES = \[)"T3 Code \((?:Alpha|Dev)\)"/g,
];

const RULES = [
  [/T3([ -]|%20|\+)Code/g, "Claude$1Code"],
  [/T3 Connect/g, "Claude Code Connect"],
  [
    /(?<![A-Za-z0-9_\\/$-])T3(?=(?:'s\b|’s\b| +(?![Cc]hat\b)[A-Za-z(]|-[a-z]|[.,;:)](?: |$)))/gm,
    "Claude Code",
  ],
];

const PRODUCT_RULES = RULES.slice(0, 2);

const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });

function rewrite(text, rules) {
  const held = [];
  for (const pattern of PROTECTED) {
    text = text.replace(pattern, (match) => `\u0001${held.push(match) - 1}\u0002`);
  }
  for (const [pattern, replacement] of rules) text = text.replace(pattern, replacement);
  return text.replace(/\u0001(\d+)\u0002/g, (_, index) => held[Number(index)]);
}

const stats = { files: 0, changed: 0, patched: 0 };
const failures = [];

for (const file of git("ls-files", "-z").split("\0")) {
  const rules = rulesFor(file);
  if (!rules) continue;
  const absolute = path.join(root, file);
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > MAX_BYTES) continue;
  const buffer = fs.readFileSync(absolute);
  if (buffer.subarray(0, 8192).includes(0)) continue;
  stats.files += 1;
  const before = buffer.toString("utf8");
  const after = rewrite(before, rules);
  if (after !== before) {
    fs.writeFileSync(absolute, after);
    stats.changed += 1;
  }
}

// Edits no text rule can express. Each must still find its anchor: a miss
// means upstream moved the code, and the sync has to stop rather than ship a
// build that silently lost the change.
const { PATCHES, REMOVE } = await import("./patches.mjs");
for (const patch of PATCHES) {
  const absolute = path.join(root, patch.file);
  if (!fs.existsSync(absolute)) {
    failures.push(`${patch.file}: file is missing (${patch.why})`);
    continue;
  }
  const before = fs.readFileSync(absolute, "utf8");
  if (before.includes(patch.done)) continue;
  const found =
    typeof patch.find === "string" ? before.includes(patch.find) : patch.find.test(before);
  if (!found) {
    failures.push(`${patch.file}: anchor not found (${patch.why})`);
    continue;
  }
  fs.writeFileSync(
    absolute,
    typeof patch.find === "string"
      ? before.replaceAll(patch.find, patch.replace)
      : before.replace(patch.find, patch.replace),
  );
  stats.patched += 1;
}
for (const entry of REMOVE) fs.rmSync(path.join(root, entry), { recursive: true, force: true });

// A release tag's manifests still carry the previous version; upstream's
// release job aligns them before building, and so must this fork.
const releaseVersion = process.argv[3];
if (releaseVersion) {
  for (const file of ["apps/server", "apps/desktop", "apps/web", "packages/contracts"]) {
    const manifest = path.join(root, file, "package.json");
    if (!fs.existsSync(manifest)) {
      failures.push(`${file}/package.json: file is missing (release version)`);
      continue;
    }
    const before = fs.readFileSync(manifest, "utf8");
    const after = before.replace(/^(  "version": ")[^"]*(")/m, `$1${releaseVersion}$2`);
    if (!after.includes(`"version": "${releaseVersion}"`)) {
      failures.push(`${file}/package.json: no version field (release version)`);
    }
    fs.writeFileSync(manifest, after);
  }
}

console.log(
  `rebrand: ${stats.changed}/${stats.files} files rewritten, ${stats.patched} patches applied`,
);
if (failures.length > 0) {
  console.error(`rebrand: ${failures.length} patch(es) no longer apply:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
