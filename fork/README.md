# Claude Code fork

This branch is [T3 Code](https://github.com/pingdotgg/t3code) with its user-facing name changed to "Claude Code", built for macOS and signed locally. Everything that makes it a fork lives in this directory; the rest of the tree is upstream's stable release with the rename replayed over it.

## What is renamed

- The app name, window title, About panel, menu and UI text: "T3 Code" becomes "Claude Code", "T3 Connect" becomes "Claude Code Connect".
- The bundle ID: `com.mytek.claudecode`.
- The installer file names: `Claude-Code-<version>-arm64.dmg` and `.zip`.
- The app icon and favicons, generated from `assets/icon-source.png` by `assets/make-icons.mjs`.
- The T3 glyph in the sidebar and tool icons, which becomes text and a "CC" monogram.

## What is not

Internal names stay as upstream has them: package names, environment variables (`T3CODE_*`), the `t3` command, the `~/.t3` data directory, MCP server and tool names, and text written for agents. Two consequences:

- The app shares `~/.t3` with a T3 Code install on the same Mac, so your projects and threads carry over. Do not run both against it at once.
- The `t3code://` URL scheme and the `t3.codes` hosts are unchanged, because T3 Connect's sign-in only accepts that origin.

## Differences in behaviour

- Signed with the certificate in the login keychain, without the passkey provisioning profile only the official team has. Passkey sign-in to T3 Connect is unavailable; the other sign-in methods work.
- Updates come from this fork's download page (`FORK_PUBLIC_URL`), never from upstream's releases.
- Usage telemetry to upstream is off unless `T3CODE_TELEMETRY_ENABLED=true`.
- Upstream's GitHub workflows are removed.

## Layout

| File | Purpose |
| --- | --- |
| `rebrand.mjs` | The rename: text rules for user-facing files, then `patches.mjs`. |
| `patches.mjs` | Edits no text rule can express. Each has an anchor that must match. |
| `sync.sh` | Daily job: merge the latest stable release, build, publish. |
| `build.sh` | Build, sign, launch-check and publish the current checkout. |
| `assets/` | The icon source, the generated icon files and their generator. |
| `site/` | The download page served through the Cloudflare tunnel. |
| `install-services.sh` | Installs the launchd agents for sync, page and tunnel. |

State sits next to the checkout, outside git: `../downloads` (published builds), `../logs`, and `../config.env`:

```sh
FORK_PUBLIC_URL=https://example.com   # origin of the download page; enables in-app updates
FORK_ARCH=arm64                       # or x64, universal
FORK_KEEP=3                           # versions kept on the page
FORK_NOTARY_PROFILE=claude-code-notary
```

## How the sync works

`sync.sh` asks GitHub for upstream's latest stable release (nightlies and previews are prereleases and are skipped). For a new tag it checks the tag out in a temporary worktree, runs `rebrand.mjs` over it, and commits the result to `upstream-rebranded` with the tag as a parent. That branch is then merged into `claude-code`.

Because the rename is replayed rather than merged, upstream changes never conflict with it. A conflict is only possible with commits you make on `claude-code` yourself; then the merge is aborted and nothing changes. The sync also stops, before touching the branch, when a patch in `patches.mjs` no longer finds its anchor, which means upstream rewrote that code and the patch needs a new anchor.

A build is published only after its signature verifies and upstream's launch check passes against the packaged app. Any failure leaves the previous build on the page and posts a macOS notification; details are in `../logs/sync.log`.

Run it by hand with `fork/sync.sh`, or `fork/sync.sh --force-build` to rebuild the current release.

## Signing

`build.sh` uses a "Developer ID Application" certificate when the keychain has one, and notarizes when `xcrun notarytool store-credentials claude-code-notary` has been set up. Otherwise it signs with the "Apple Development" certificate. That signature is valid and stable, but Gatekeeper does not accept it for a downloaded app: open it once through System Settings → Privacy & Security → Open Anyway, or install with the `curl` command on the download page, which avoids quarantine.
