#!/bin/bash
#
# Build, sign and notarize the macOS app with your Developer ID, so it opens with
# a plain double-click on any Mac — no "damaged", no right-click, no Terminal.
#
# The signing certificate is read from your login Keychain and never leaves this
# machine. The only secret this needs is your app-specific password, passed in
# the environment so it stays in your shell:
#
#   export APPLE_ID="you@example.com"
#   export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # appleid.apple.com
#   export APPLE_TEAM_ID="C9NLF34677"
#   npm run release:mac
#
# Create the app-specific password at appleid.apple.com → Sign-In and Security →
# App-Specific Passwords. It is NOT your Apple ID password.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

: "${APPLE_ID:?set APPLE_ID to your Apple ID email}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?set APPLE_APP_SPECIFIC_PASSWORD (from appleid.apple.com)}"
: "${APPLE_TEAM_ID:=C9NLF34677}"

echo "==> signing as Developer ID for team $APPLE_TEAM_ID, notarizing as $APPLE_ID"

# Tell electron-builder to discover the Developer ID cert from the Keychain and
# to notarize; HEARTH_DEVELOPER_ID keeps the ad-hoc fallback out of the way.
export CSC_IDENTITY_AUTO_DISCOVERY=true
export HEARTH_DEVELOPER_ID=1

npx electron-builder --mac \
  --config.mac.notarize.teamId="$APPLE_TEAM_ID" \
  --publish never

echo ""
echo "==> verifying the result"
APP=$(find dist -maxdepth 2 -name 'Hearth.app' -type d | head -1)
if [ -n "$APP" ]; then
  echo "-- codesign authority --"
  codesign -dv --verbose=2 "$APP" 2>&1 | grep -E "Authority|TeamIdentifier|Runtime" | head -4
  echo "-- notarization / Gatekeeper verdict --"
  spctl -a -vvv "$APP" 2>&1 | head -3
  echo "-- staple check --"
  xcrun stapler validate "$APP" 2>&1 | tail -1
fi

echo ""
echo "Signed, notarized installers are in desktop/dist/:"
ls -1 dist/*.dmg 2>/dev/null || true
echo ""
echo "Publish them to the current release with:"
echo "  gh release upload v1.0.0 dist/Hearth-mac-arm64.dmg dist/Hearth-mac-x64.dmg --clobber"
