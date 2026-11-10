#!/bin/bash
# Builds, signs and smoke-tests the macOS app from the current checkout, then
# publishes it to the download directory. A failure at any step leaves the
# previously published build in place.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$REPO"

tag="$(base_tag)"
version="${tag#v}"
arch="${FORK_ARCH:-arm64}"
commit="$(git rev-parse --short=12 HEAD)"
log "Building Claude Code $version ($arch) from $commit"

# The public Clerk and relay identifiers official releases are built with;
# without them the build has no T3 Connect.
cp .env.example .env
if [[ -f "$FORK_HOME/env.local" ]]; then cat "$FORK_HOME/env.local" >> .env; fi

toolchain pnpm install --frozen-lockfile \
  --filter='t3...' --filter='@t3tools/web...' --filter='@t3tools/desktop...' --filter='@t3tools/scripts...'

rm -rf apps/server/dist apps/desktop/dist-electron release
toolchain pnpm exec vp run build:desktop:bundle

# A Developer ID certificate gives a build Gatekeeper accepts; without one the
# Apple Development certificate still gives a stable, verifiable signature.
identities="$(security find-identity -v -p codesigning)"
signer=""
notarized=false
if grep -q '"Developer ID Application: ' <<<"$identities"; then
  signer="$(sed -n 's/.*"\(Developer ID Application: [^"]*\)".*/\1/p' <<<"$identities" | head -1)"
  profile="${FORK_NOTARY_PROFILE:-claude-code-notary}"
  # A Developer ID build that is not notarized is still blocked by Gatekeeper,
  # so a missing profile stops the build instead of quietly publishing one.
  if xcrun notarytool history --keychain-profile "$profile" >/dev/null 2>&1; then
    export APPLE_KEYCHAIN_PROFILE="$profile" FORK_MAC_NOTARIZE=true
    notarized=true
  elif [[ "${FORK_ALLOW_UNNOTARIZED:-}" != "true" ]]; then
    log "Notarization profile '$profile' is missing from the keychain. Restore it with: xcrun notarytool store-credentials $profile"
    exit 1
  fi
elif grep -q '"Apple Development: ' <<<"$identities"; then
  signer="$(sed -n 's/.*"\(Apple Development: [^"]*\)".*/\1/p' <<<"$identities" | head -1)"
  export FORK_MAC_IDENTITY="${signer#Apple Development: }" FORK_MAC_SIGN_TYPE=development
else
  log "No code signing certificate in the keychain."
  exit 1
fi
log "Signing as $signer (notarize: $notarized)"

if [[ -n "${FORK_PUBLIC_URL:-}" ]]; then export FORK_UPDATE_URL="${FORK_PUBLIC_URL%/}/"; fi
toolchain pnpm exec vp run dist:desktop:artifact \
  --platform mac --target dmg --arch "$arch" --build-version "$version" --skip-build --signed

dmg="release/Claude-Code-$version-$arch.dmg"
zip="release/Claude-Code-$version-$arch.zip"
[[ -f "$dmg" && -f "$zip" ]] || { log "Build did not produce $dmg and $zip"; exit 1; }

# Check the artifact a user downloads, not the staging directory.
check="$(mktemp -d "${TMPDIR:-/tmp}/claude-code-check.XXXXXX")"
trap 'rm -rf "$check"' EXIT
ditto -x -k "$zip" "$check"
app="$check/Claude Code.app"
codesign --verify --deep --strict "$app"
signature="$(codesign -dvv "$app" 2>&1)"
grep -q "^Authority=$signer" <<<"$signature" || { log "App is not signed by $signer"; exit 1; }
toolchain node scripts/smoke-desktop-app.ts \
  --executable "$app/Contents/MacOS/Claude Code" --artifacts-dir "$LOGS/launch-check"
log "Signature and launch check passed"

# Files first, manifest last: the page and the updater only ever see a
# manifest whose files are complete.
for file in release/Claude-Code-"$version"-"$arch".*; do
  cp "$file" "$DOWNLOADS/.$(basename "$file").part"
  mv "$DOWNLOADS/.$(basename "$file").part" "$DOWNLOADS/$(basename "$file")"
done
if [[ -f release/latest-mac.yml ]]; then
  cp release/latest-mac.yml "$DOWNLOADS/.latest-mac.yml.part"
  mv "$DOWNLOADS/.latest-mac.yml.part" "$DOWNLOADS/latest-mac.yml"
fi
jq -n \
  --arg version "$version" --arg tag "$tag" --arg arch "$arch" --arg commit "$commit" \
  --arg builtAt "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" --arg signer "$signer" \
  --argjson notarized "$notarized" \
  --arg dmg "$(basename "$dmg")" --arg zip "$(basename "$zip")" \
  --arg dmgSha "$(shasum -a 256 "$dmg" | cut -d' ' -f1)" \
  --arg zipSha "$(shasum -a 256 "$zip" | cut -d' ' -f1)" \
  --argjson dmgSize "$(stat -f%z "$dmg")" --argjson zipSize "$(stat -f%z "$zip")" \
  '{version: $version, tag: $tag, arch: $arch, commit: $commit, builtAt: $builtAt,
    signer: $signer, notarized: $notarized,
    dmg: {name: $dmg, sha256: $dmgSha, size: $dmgSize},
    zip: {name: $zip, sha256: $zipSha, size: $zipSize}}' > "$DOWNLOADS/.build.json.part"
mv "$DOWNLOADS/.build.json.part" "$DOWNLOADS/build.json"

# Keep the newest few versions for rollback.
keep="${FORK_KEEP:-3}"
ls -t "$DOWNLOADS"/Claude-Code-*.dmg 2>/dev/null | tail -n "+$((keep + 1))" | while read -r old; do
  rm -f "${old%.dmg}".*
done

log "Published Claude Code $version to $DOWNLOADS"
