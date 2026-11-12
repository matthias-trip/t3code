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

# Merge drivers named in .gitattributes. `fork-ours` keeps this branch's copy
# of a generated file; regenerate it after the merge (fork/routes.mjs).
setup_merge_drivers() {
  git -C "$REPO" config merge.fork-ours.name "keep ours, regenerate after merge"
  git -C "$REPO" config merge.fork-ours.driver true
}
