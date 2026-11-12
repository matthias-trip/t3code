# Shared setup for the fork scripts. Source it; do not run it.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# State (downloads, logs, config) sits next to the checkout, outside git.
FORK_HOME="${FORK_HOME:-$(dirname "$REPO")}"
DOWNLOADS="$FORK_HOME/downloads"
LOGS="$FORK_HOME/logs"
UPSTREAM_REPO="pingdotgg/t3code"
BRANCH="claude-code"
VENDOR_BRANCH="upstream-rebranded"

mkdir -p "$DOWNLOADS" "$LOGS"

# launchd starts with a bare PATH.
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# A T3 Code or Claude session leaks its home, ports and tokens into child
# processes; a build or test launch must never pick those up.
for name in $(env | grep -E '^(T3CODE_|T3_|CLAUDE_|CLAUDECODE|ELECTRON_|VITE_)' | cut -d= -f1); do
  unset "$name"
done

# Optional settings: FORK_PUBLIC_URL, FORK_ARCH, FORK_NOTARY_PROFILE, FORK_KEEP.
if [[ -f "$FORK_HOME/config.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$FORK_HOME/config.env"
  set +a
fi

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

notify() {
  osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1 || true
}

# Runs a command under the Node.js and pnpm versions the checkout pins.
toolchain() {
  local node pnpm
  node="$(jq -r '.engines.node' "$REPO/package.json")"
  pnpm="$(jq -r '.packageManager' "$REPO/package.json" | sed 's/^pnpm@//')"
  mise exec "node@$node" "pnpm@$pnpm" -- "$@"
}

# The upstream release the checkout is based on, such as v0.1.8.
base_tag() {
  git -C "$REPO" describe --tags --abbrev=0 --match 'v[0-9]*' --exclude '*-*' HEAD
}

# Generated files a merge must not conflict on. `fork-ours` keeps this
# branch's copy; post_merge regenerates it (fork/routes.mjs). The attribute
# lives in .git/info/attributes, not .gitattributes, which is upstream's.
FORK_OURS_FILES=("apps/web/src/routeTree.gen.ts")

setup_merge_drivers() {
  local repo="${1:-$REPO}" attributes
  git -C "$repo" config merge.fork-ours.name "keep ours, regenerate after merge"
  git -C "$repo" config merge.fork-ours.driver true
  attributes="$(git -C "$repo" rev-parse --git-common-dir)/info/attributes"
  mkdir -p "$(dirname "$attributes")"
  touch "$attributes"
  for file in "${FORK_OURS_FILES[@]}"; do
    grep -qxF "$file merge=fork-ours" "$attributes" || echo "$file merge=fork-ours" >>"$attributes"
  done
}

# Rebrands upstream <tag> with the fork/ committed at HEAD and prints the
# resulting tree id. The rebrand runs from a copy, so the vendor tree holds
# only upstream files.
rebrand_tree() {
  local tag="$1" work tree
  work="$(mktemp -d "${TMPDIR:-/tmp}/claude-code-rebrand.XXXXXX")"
  git -C "$REPO" archive HEAD fork | tar -x -C "$work"
  git -C "$REPO" worktree add --quiet --detach "$work/tree" "$tag"
  if node "$work/fork/rebrand.mjs" "$work/tree" "${tag#v}" >&2; then
    git -C "$work/tree" add -A
    tree="$(git -C "$work/tree" write-tree)"
  fi
  git -C "$REPO" worktree remove --force "$work/tree" >/dev/null 2>&1 || true
  rm -rf "$work"
  [[ -n "${tree:-}" ]] && echo "$tree"
}

# Merges <ref> into the checkout at <dir>. A conflict confined to
# pnpm-lock.yaml is resolved by pnpm itself, which rewrites a conflicted
# lockfile on install. Anything else aborts the merge and fails.
merge_resolving_lockfile() {
  local dir="$1" ref="$2" message="$3" log_file="$4" conflicts
  if git -C "$dir" merge --no-verify --no-edit -m "$message" "$ref" >"$log_file" 2>&1; then
    return 0
  fi
  conflicts="$(git -C "$dir" diff --name-only --diff-filter=U)"
  if [[ "$conflicts" == "pnpm-lock.yaml" ]] &&
    (cd "$dir" && toolchain pnpm install --no-frozen-lockfile --ignore-scripts >>"$log_file" 2>&1); then
    git -C "$dir" add pnpm-lock.yaml
    git -C "$dir" commit --no-verify --no-edit >>"$log_file" 2>&1 && return 0
  fi
  git -C "$dir" merge --abort >/dev/null 2>&1 || true
  return 1
}

# After a merge in <dir>: install, regenerate fork-ours files, commit them if
# they changed, then typecheck the packages the overlay touches. A stale
# route tree fails the web typecheck, so a missed regenerate cannot publish.
post_merge() {
  local dir="$1" log_file="$2" pkg
  (
    cd "$dir"
    toolchain pnpm install --frozen-lockfile >>"$log_file" 2>&1
    toolchain node fork/routes.mjs "$dir" >>"$log_file" 2>&1
    if [[ -n "$(git status --porcelain -- "${FORK_OURS_FILES[@]}")" ]]; then
      git add -- "${FORK_OURS_FILES[@]}"
      git commit --no-verify --quiet -m "fork: regenerate generated files after merge"
    fi
    for pkg in packages/fork-* apps/server apps/web; do
      [[ -d "$pkg" ]] || continue
      (cd "$pkg" && toolchain pnpm exec vp run typecheck) >>"$log_file" 2>&1 || {
        echo "typecheck failed in $pkg" >>"$log_file"
        exit 1
      }
    done
  )
}
