#!/bin/bash
# Starts the download page; launchd keeps it running.
set -euo pipefail
source "$(dirname "$0")/../lib.sh"
exec node "$REPO/fork/site/server.mjs" "$DOWNLOADS" "${FORK_SITE_PORT:-8791}"
