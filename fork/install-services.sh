#!/bin/bash
# Installs the three launchd agents: the daily sync, the download page, and
# the Cloudflare tunnel in front of it. Run again after moving the checkout.
#
# The tunnel is remotely managed: its public hostname and origin
# (http://127.0.0.1:8791) are configured in Cloudflare, and its token is read
# from ~/.cloudflared/claude-code.token.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

agents="$HOME/Library/LaunchAgents"
token="$HOME/.cloudflared/claude-code.token"
domain="gui/$(id -u)"
mkdir -p "$agents"

write() {
  local label="$1" body="$2"
  cat > "$agents/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
$body
</dict>
</plist>
PLIST
  launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "$domain" "$agents/$label.plist"
  log "Loaded $label"
}

# Daily at 06:30; launchd runs a missed start when the Mac next wakes.
write com.mytek.claudecode.sync "  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$REPO/fork/sync.sh</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>30</integer></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOGS/sync.log</string>
  <key>StandardErrorPath</key><string>$LOGS/sync.log</string>"

write com.mytek.claudecode.site "  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$REPO/fork/site/serve.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOGS/site.log</string>
  <key>StandardErrorPath</key><string>$LOGS/site.log</string>"

if [[ -f "$token" ]]; then
  write com.mytek.claudecode.tunnel "  <key>ProgramArguments</key>
  <array>
    <string>$(command -v cloudflared)</string><string>tunnel</string><string>--no-autoupdate</string>
    <string>run</string><string>--token-file</string><string>$token</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOGS/tunnel.log</string>
  <key>StandardErrorPath</key><string>$LOGS/tunnel.log</string>"
else
  log "No tunnel token at $token; skipped the tunnel agent"
fi
