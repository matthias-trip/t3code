#!/bin/bash
# Daily sync: merges the latest stable T3 Code release into this fork, then
# builds and publishes it. Safe to run at any time; with nothing new it exits.
#
# Each upstream release is rebranded onto the vendor branch as one commit, and
# that branch is merged into claude-code. The rename is replayed by script, so
# upstream changes never conflict with it; only hand edits made on claude-code
# can conflict, and then the sync stops and leaves everything as it was.
#
# Usage: sync.sh [--force-build | --no-build] [tag]
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$REPO"

force_build=false
build=true
tag=""
for arg in "$@"; do
  case "$arg" in
    --force-build) force_build=true ;;
    --no-build) build=false ;;
    *) tag="$arg" ;;
  esac
done

fail() {
  log "FAILED: $*"
  notify "Claude Code sync failed" "$*"
  exit 1
}

[[ "$(git rev-parse --abbrev-ref HEAD)" == "$BRANCH" ]] || fail "checkout is not on $BRANCH"
[[ -z "$(git status --porcelain)" ]] || fail "checkout has uncommitted changes"

# Stable releases only: nightlies and previews are prereleases, which
# releases/latest never returns.
[[ -n "$tag" ]] || tag="$(gh api "repos/$UPSTREAM_REPO/releases/latest" --jq .tag_name)" ||
  fail "could not read the latest upstream release"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "unexpected release tag '$tag'"
git fetch --quiet --no-tags upstream "refs/tags/$tag:refs/tags/$tag" || fail "could not fetch $tag"
git fetch --quiet origin || true

# Rebrand the release into a tree. This runs every time, not only for a new
# tag, so a change to the rebrand rules reaches the branch on the next run.
# The rebrand in use is the one committed on claude-code.
tree="$(rebrand_tree "$tag")" || fail "rebrand no longer applies to $tag"

# A retry after a failed merge finds the same tree already on the vendor
# branch and must not stack a second commit on it.
if [[ "$(git rev-parse --quiet --verify "$VENDOR_BRANCH^{tree}" || true)" != "$tree" ]]; then
  parents=()
  if git rev-parse --quiet --verify "refs/heads/$VENDOR_BRANCH" >/dev/null; then
    parents+=(-p "$VENDOR_BRANCH")
    git merge-base --is-ancestor "$tag^{commit}" "$VENDOR_BRANCH" || parents+=(-p "$tag^{commit}")
  else
    parents+=(-p "$tag^{commit}")
  fi
  vendor="$(git commit-tree "$tree" "${parents[@]}" -m "Rebrand upstream $tag as Claude Code")"
  git update-ref "refs/heads/$VENDOR_BRANCH" "$vendor"
fi

merged=false
if git merge-base --is-ancestor "$VENDOR_BRANCH" HEAD; then
  log "$tag is already merged"
else
  log "Merging upstream $tag"
  before="$(git rev-parse HEAD)"
  setup_merge_drivers
  merge_resolving_lockfile "$REPO" "$VENDOR_BRANCH" "Merge upstream $tag" "$LOGS/merge.log" ||
    fail "merge of $tag conflicts with local changes; see $LOGS/merge.log"
  # The fork overlay must still build on the new release before anything is
  # pushed; otherwise the branch goes back to where it was.
  if ! post_merge "$REPO" "$LOGS/merge.log"; then
    git reset --quiet --hard "$before"
    fail "fork overlay does not typecheck on $tag; see $LOGS/merge.log"
  fi
  merged=true
  git push --quiet origin "$BRANCH" "$VENDOR_BRANCH" || log "Push failed; continuing with the local merge"
fi

[[ "$build" == true ]] || exit 0

published="$(jq -r '.tag // empty' "$DOWNLOADS/build.json" 2>/dev/null || true)"
published_commit="$(jq -r '.commit // empty' "$DOWNLOADS/build.json" 2>/dev/null || true)"
if [[ "$merged" == false && "$force_build" == false && "$published" == "$(base_tag)" &&
  "$published_commit" == "$(git rev-parse --short=12 HEAD)" ]]; then
  log "Build for $published is already published; nothing to do"
  exit 0
fi

"$REPO/fork/build.sh" || fail "build of $(base_tag) failed; the previous build stays published"
notify "Claude Code $(base_tag) is ready" "A new signed build is on the download page."
