#!/usr/bin/env node
// Rebrands an upstream T3 Code tree to "Claude Code" in the names a person
// sees; internal names, protocols and agent-facing text stay upstream's.
// Deterministic and idempotent: the daily sync replays it on every release.
// Usage: node fork/rebrand.mjs [tree-root] [release-version]
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const root = NodePath.resolve(process.argv[2] ?? NodePath.join(import.meta.dirname, ".."));
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
const AGENT_FACING = [
  /mcp/i,
  /instructions/i,
  /prompt/i,
  /textGeneration/i,
  /pullRequestWatch/i,
  /htmlRender/,
  /testkit/,
];
const NEVER = [
  /\/fixtures\//,
  /\.snap$/,
  // Profile directories on disk, including earlier upstream versions' read
  // for migration. These files hold no interface text.
  /^apps\/desktop\/src\/app\/(?:DesktopUserData|DesktopLegacyLocalStorage)(?:\.test)?\.ts$/,
  // Thread titles a user typed, ranked against the query "t3co".
  /^packages\/shared\/src\/paletteSearch\.test\.ts$/,
];

function rulesFor(file) {
  if (NEVER.some((pattern) => pattern.test(file))) return null;
  const screen =
    /^apps\/(?:web|desktop)\//.test(file) ||
    // Link errors and tool-call labels shown in the timeline.
    /^packages\/(?:shared|client-runtime)\/src\/(?:promptLinks|t3McpToolPresentation)\.ts$/.test(
      file,
    );
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
  NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });

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
// Every edit is staged here and written only once all patches have found
// their anchors, so a failed run leaves the tree exactly as it was.
const staged = new Map();
const read = (absolute) => staged.get(absolute) ?? NodeFS.readFileSync(absolute, "utf8");

for (const file of git("ls-files", "-z").split("\0")) {
  const rules = rulesFor(file);
  if (!rules) continue;
  const absolute = NodePath.join(root, file);
  const stat = NodeFS.lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > MAX_BYTES) continue;
  const buffer = NodeFS.readFileSync(absolute);
  if (buffer.subarray(0, 8192).includes(0)) continue;
  stats.files += 1;
  const before = buffer.toString("utf8");
  const after = rewrite(before, rules);
  if (after !== before) {
    staged.set(absolute, after);
    stats.changed += 1;
  }
}

// Edits no text rule can express. Each must still find its anchor: a miss
// means upstream moved the code, and the sync has to stop rather than ship a
// build that silently lost the change.
const { ASSETS, CLI, PATCHES, REMOVE } = await import("./patches.mjs");

// The command name appears as a quoted file name, in backticks, as the text
// of a <code> element, and in "t3 command" and "t3 launcher".
for (const file of CLI.files) {
  const absolute = NodePath.join(root, file);
  if (!NodeFS.existsSync(absolute)) {
    failures.push(`${file}: file is missing (command name)`);
    continue;
  }
  const before = read(absolute);
  const after = before
    .replace(/"t3(\.cmd|\.exe)?"/g, `"${CLI.name}$1"`)
    .replace(/`t3`/g, `\`${CLI.name}\``)
    .replace(/>t3</g, `>${CLI.name}<`)
    .replace(/\bt3 (command|launcher)\b/g, `${CLI.name} $1`)
    .replace(/\banother t3\b/g, `another ${CLI.name}`)
    .replace(/bundled t3 CLI/g, `bundled ${CLI.name} CLI`);
  if (after === before && !before.includes(CLI.name)) {
    failures.push(`${file}: no command name found (command name)`);
  }
  staged.set(absolute, after);
}
for (const patch of PATCHES) {
  const absolute = NodePath.join(root, patch.file);
  if (!NodeFS.existsSync(absolute)) {
    failures.push(`${patch.file}: file is missing (${patch.why})`);
    continue;
  }
  const before = read(absolute);
  if (before.includes(patch.done)) continue;
  const found =
    typeof patch.find === "string" ? before.includes(patch.find) : patch.find.test(before);
  if (!found) {
    failures.push(`${patch.file}: anchor not found (${patch.why})`);
    continue;
  }
  staged.set(
    absolute,
    typeof patch.find === "string"
      ? before.replaceAll(patch.find, patch.replace)
      : before.replace(patch.find, patch.replace),
  );
  stats.patched += 1;
}
for (const target of Object.keys(ASSETS)) {
  if (!NodeFS.existsSync(NodePath.join(root, target))) {
    failures.push(`${target}: file is missing (icon replacement)`);
  }
}

// A release tag's manifests still carry the previous version; upstream's
// release job aligns them before building, and so must this fork.
const releaseVersion = process.argv[3];
if (releaseVersion) {
  for (const file of ["apps/server", "apps/desktop", "apps/web", "packages/contracts"]) {
    const manifest = NodePath.join(root, file, "package.json");
    if (!NodeFS.existsSync(manifest)) {
      failures.push(`${file}/package.json: file is missing (release version)`);
      continue;
    }
    const before = read(manifest);
    const after = before.replace(/^(  "version": ")[^"]*(")/m, `$1${releaseVersion}$2`);
    if (!after.includes(`"version": "${releaseVersion}"`)) {
      failures.push(`${file}/package.json: no version field (release version)`);
    }
    staged.set(manifest, after);
  }
}

if (failures.length > 0) {
  console.error(
    `rebrand: ${failures.length} patch(es) no longer apply, nothing written:\n  ${failures.join("\n  ")}`,
  );
  process.exit(1);
}
for (const [absolute, text] of staged) {
  if (NodeFS.readFileSync(absolute, "utf8") !== text) NodeFS.writeFileSync(absolute, text);
}
for (const [target, asset] of Object.entries(ASSETS)) {
  NodeFS.copyFileSync(
    NodePath.join(import.meta.dirname, "assets", asset),
    NodePath.join(root, target),
  );
}
for (const entry of REMOVE)
  NodeFS.rmSync(NodePath.join(root, entry), { recursive: true, force: true });

console.log(
  `rebrand: ${stats.changed}/${stats.files} files rewritten, ${stats.patched} patches applied`,
);
