#!/bin/bash
# Dry run of the daily sync for the fork overlay: rebrands an upstream tag
# with the fork/ at HEAD, merges it into a throwaway worktree of HEAD, then
# regenerates and typechecks as sync.sh would. Pushes nothing, builds nothing,
# and leaves no branch behind. Run it before merging overlay work.
#
# Usage: check-overlay.sh [tag]   (default: the tag HEAD is based on)
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$REPO"

tag="${1:-$(base_tag)}"
git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null ||
  git fetch --quiet --no-tags upstream "refs/tags/$tag:refs/tags/$tag"

log_file="$LOGS/check-overlay.log"
: >"$log_file"
work="$(mktemp -d "${TMPDIR:-/tmp}/claude-code-overlay.XXXXXX")"
cleanup() {
  git worktree remove --force "$work/head" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

log "Rebranding $tag"
tree="$(rebrand_tree "$tag")" || { log "FAILED: rebrand no longer applies to $tag"; exit 1; }
vendor="$(git commit-tree "$tree" -p "$tag^{commit}" -m "Rebrand upstream $tag (check-overlay)")"

log "Merging into a scratch copy of $(git rev-parse --short HEAD)"
git worktree add --quiet --detach "$work/head" HEAD
setup_merge_drivers
merge_resolving_lockfile "$work/head" "$vendor" "check-overlay: merge $tag" "$log_file" ||
  { log "FAILED: merge conflicts; see $log_file"; exit 1; }

log "Installing, regenerating and typechecking"
post_merge "$work/head" "$log_file" || { log "FAILED: see $log_file"; exit 1; }
log "OK: overlay merges and typechecks on $tag"
