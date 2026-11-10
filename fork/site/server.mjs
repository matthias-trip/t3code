#!/usr/bin/env node
// Download page for the fork's builds, served to a Cloudflare tunnel. It also
// hosts latest-mac.yml and the zip, which the app's updater reads.
//
// Usage: node server.mjs <downloads-dir> [port]
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

const downloads = path.resolve(process.argv[2] ?? "downloads");
const port = Number(process.argv[3] ?? 8791);
const SERVED = /^(?:Claude-Code-[0-9A-Za-z.-]+\.(?:dmg|zip)(?:\.blockmap)?|latest-mac\.yml|build\.json)$/;
const TYPES = {
  ".dmg": "application/x-apple-diskimage",
  ".zip": "application/zip",
  ".yml": "text/yaml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".blockmap": "application/octet-stream",
};

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

function readBuild() {
  try {
    return JSON.parse(fs.readFileSync(path.join(downloads, "build.json"), "utf8"));
  } catch {
    return null;
  }
}

function olderBuilds(current) {
  return fs
    .readdirSync(downloads)
    .filter((name) => /^Claude-Code-.*\.dmg$/.test(name) && name !== current)
    .map((name) => ({ name, time: fs.statSync(path.join(downloads, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
}

function page(build, origin) {
  const body = build
    ? `
    <p class="meta">Version <strong>${escapeHtml(build.version)}</strong> for Apple silicon
      · built <time datetime="${escapeHtml(build.builtAt)}">${escapeHtml(build.builtAt.slice(0, 16).replace("T", " "))} UTC</time>
      · upstream <a href="https://github.com/pingdotgg/t3code/releases/tag/${escapeHtml(build.tag)}">T3 Code ${escapeHtml(build.tag)}</a></p>
    <p><a class="button" href="/${escapeHtml(build.dmg.name)}">Download for macOS</a>
      <span class="size">${megabytes(build.dmg.size)} · .dmg</span></p>
    <h2>Install from Terminal</h2>
    <p>${
      build.notarized
        ? "The download above opens normally. This does the same in one step:"
        : "This build is signed but not notarized by Apple, so macOS blocks the downloaded .dmg until you allow it under System Settings → Privacy &amp; Security → Open Anyway. Installing from Terminal avoids that:"
    }</p>
    <pre><code>curl -fL ${escapeHtml(origin)}/${escapeHtml(build.zip.name)} -o /tmp/claude-code.zip &amp;&amp; \\
  ditto -x -k /tmp/claude-code.zip /Applications &amp;&amp; open "/Applications/Claude Code.app"</code></pre>
    <h2>Verify</h2>
    <dl>
      <dt>Signed by</dt><dd>${escapeHtml(build.signer)}${build.notarized ? " · notarized" : ""}</dd>
      <dt>Commit</dt><dd><code>${escapeHtml(build.commit)}</code></dd>
      <dt>SHA-256 .dmg</dt><dd><code>${escapeHtml(build.dmg.sha256)}</code></dd>
      <dt>SHA-256 .zip</dt><dd><code>${escapeHtml(build.zip.sha256)}</code></dd>
    </dl>
    ${(() => {
      const older = olderBuilds(build.dmg.name);
      return older.length === 0
        ? ""
        : `<h2>Earlier builds</h2><ul>${older
            .map((entry) => `<li><a href="/${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</a></li>`)
            .join("")}</ul>`;
    })()}`
    : `<p class="meta">No build has been published yet. The daily sync publishes one after its first successful run.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Claude Code – download</title>
<style>
  :root { color-scheme: light dark; --fg: #1a1a1a; --muted: #6b6b6b; --bg: #fafaf8; --line: #e4e2dc; --accent: #c15f3c; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ecebe7; --muted: #9a9892; --bg: #1c1b19; --line: #34322e; --accent: #d97757; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.55 system-ui, -apple-system, sans-serif; }
  main { max-width: 42rem; margin: 0 auto; padding: 4rem 1.5rem; }
  h1 { font-size: 2rem; letter-spacing: -0.02em; margin: 0 0 0.25rem; }
  h2 { font-size: 1rem; margin: 2.5rem 0 0.5rem; }
  .meta, .size, dt { color: var(--muted); }
  .meta { margin: 0 0 2rem; }
  a { color: var(--accent); }
  .button { display: inline-block; background: var(--accent); color: #fff; text-decoration: none; font-weight: 600; padding: 0.7rem 1.4rem; border-radius: 0.5rem; margin-right: 0.75rem; }
  pre { background: color-mix(in srgb, var(--fg) 6%, transparent); border: 1px solid var(--line); border-radius: 0.5rem; padding: 0.9rem 1rem; overflow-x: auto; font-size: 0.85rem; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.35rem 1.25rem; margin: 0; font-size: 0.9rem; }
  dd { margin: 0; overflow-wrap: anywhere; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); color: var(--muted); font-size: 0.85rem; }
</style>
</head>
<body>
<main>
  <h1>Claude Code</h1>
  ${body}
  <footer>A personal rebrand of the open-source <a href="https://github.com/pingdotgg/t3code">T3 Code</a>, rebuilt from each stable release. Not affiliated with Anthropic or T3 Tools. Installed copies update themselves from this page.</footer>
</main>
</body>
</html>`;
}

function sendFile(request, response, name) {
  const file = path.join(downloads, name);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    return;
  }
  const extension = path.extname(name);
  const headers = {
    "content-type": TYPES[extension] ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "x-robots-tag": "noindex",
    // A rebuild of the same release reuses its file names, so nothing here
    // may be cached without asking: the validator below keeps that cheap.
    "cache-control": /^(?:latest-mac\.yml|build\.json)$/.test(name) ? "no-store" : "no-cache",
    etag: `"${stat.size}-${Math.round(stat.mtimeMs)}"`,
    "cdn-cache-control": "no-store",
  };
  if (request.headers["if-none-match"] === headers.etag) {
    response.writeHead(304, headers).end();
    return;
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) {
      response.writeHead(416, { "content-range": `bytes */${stat.size}` }).end();
      return;
    }
    response.writeHead(206, {
      ...headers,
      "content-range": `bytes ${start}-${end}/${stat.size}`,
      "content-length": end - start + 1,
    });
    if (request.method === "HEAD") return void response.end();
    fs.createReadStream(file, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...headers, "content-length": stat.size });
  if (request.method === "HEAD") return void response.end();
  fs.createReadStream(file).pipe(response);
}

http
  .createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const name = decodeURIComponent(url.pathname.slice(1));
    if (name === "") {
      const host = request.headers["x-forwarded-host"] ?? request.headers.host ?? "localhost";
      const proto = request.headers["x-forwarded-proto"] ?? "https";
      const html = page(readBuild(), `${proto}://${host}`);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag": "noindex",
      });
      response.end(request.method === "HEAD" ? undefined : html);
      return;
    }
    if (name === "robots.txt") {
      response.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /\n");
      return;
    }
    if (!SERVED.test(name)) {
      response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
      return;
    }
    sendFile(request, response, name);
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`Serving ${downloads} on http://127.0.0.1:${port}`);
  });
