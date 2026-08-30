#!/bin/bash
#
# Builds Hearth.app.
#
#   ./mac/build.sh            build into mac/build/Hearth.app
#   ./mac/build.sh /Applications   build and install there
#
# Needs the Xcode command line tools. The app itself needs Node 18+ on the
# machine at runtime; everything else is bundled inside it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$ROOT/mac/build}"
APP="$OUT/Hearth.app"
VERSION="1.0.0"

echo "==> building Hearth.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# --- the native binary
echo "  compiling main.swift"
swiftc -O -whole-module-optimization \
  -target arm64-apple-macosx13.0 \
  -framework AppKit -framework WebKit \
  -o "$APP/Contents/MacOS/Hearth" \
  "$ROOT/mac/Sources/main.swift"

# --- the daemon, bundled so the app is self-contained apart from Node itself
echo "  bundling the session daemon"
mkdir -p "$APP/Contents/Resources/app/lib" "$APP/Contents/Resources/app/web"
cp "$ROOT/hearth.js" "$ROOT/relay.js" "$APP/Contents/Resources/app/"
cp "$ROOT"/lib/*.js "$ROOT"/lib/*.ps1 "$APP/Contents/Resources/app/lib/"
cp "$ROOT/web/app.html" "$APP/Contents/Resources/app/web/"

# --- icon
echo "  drawing the icon"
ICONSET="$OUT/Hearth.iconset"
rm -rf "$ICONSET"
node "$ROOT/tools/make-icon.js" iconset "$ICONSET" > /dev/null
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Hearth.icns"
rm -rf "$ICONSET"

# --- Info.plist
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Hearth</string>
  <key>CFBundleDisplayName</key><string>Hearth</string>
  <key>CFBundleIdentifier</key><string>dev.hearth.app</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Hearth</string>
  <key>CFBundleIconFile</key><string>Hearth</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>MIT</string>
  <!-- The session window is served from loopback over plain http, which ATS
       blocks by default. Nothing else is reachable from the app. -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
PLIST

# --- ad-hoc signature, enough for running locally on this machine
echo "  signing (ad-hoc)"
codesign --force --deep --sign - "$APP" 2>/dev/null || echo "  (signing skipped)"

echo ""
echo "built: $APP"
echo "run:   open '$APP'"
