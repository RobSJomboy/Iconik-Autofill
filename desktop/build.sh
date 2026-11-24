#!/bin/bash
# Builds "Push to Iconik.app" (universal: Apple Silicon + Intel), ad-hoc signed, into ../app/ for GitHub Pages.
#   VERSION=1.0.1 NOTES="what changed" ./build.sh   then commit app/ and push: every installed copy offers the update.
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${VERSION:-1.0.0}"
OUT=build; APP="$OUT/Push to Iconik.app"
rm -rf "$OUT"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" ../app
swiftc -swift-version 5 -O -target arm64-apple-macos12  -o "$OUT/arm64"  main.swift
swiftc -swift-version 5 -O -target x86_64-apple-macos12 -o "$OUT/x86_64" main.swift
lipo -create "$OUT/arm64" "$OUT/x86_64" -output "$APP/Contents/MacOS/PushToIconik"
cp -R ui "$APP/Contents/Resources/ui"
# icon
swiftc -swift-version 5 -o "$OUT/make_icon" make_icon.swift && "$OUT/make_icon" "$OUT/icon_1024.png"
IS="$OUT/AppIcon.iconset"; mkdir -p "$IS"
for s in 16 32 128 256 512; do
  sips -z $s $s "$OUT/icon_1024.png" --out "$IS/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$OUT/icon_1024.png" --out "$IS/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$IS" -o "$APP/Contents/Resources/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Push to Iconik</string>
  <key>CFBundleDisplayName</key><string>Push to Iconik</string>
  <key>CFBundleIdentifier</key><string>com.jomboymedia.pushtoiconik</string>
  <key>CFBundleExecutable</key><string>PushToIconik</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Jomboy Media</string>
  <key>CFBundleDocumentTypes</key><array><dict>
    <key>CFBundleTypeName</key><string>Video</string><key>CFBundleTypeRole</key><string>Viewer</string>
    <key>LSHandlerRank</key><string>Alternate</string>
    <key>LSItemContentTypes</key><array><string>public.movie</string><string>public.audio</string></array>
  </dict></array>
</dict></plist>
PLIST
codesign --force --deep --sign - "$APP"
(cd "$OUT" && ditto -c -k --keepParent "Push to Iconik.app" ../../app/PushToIconik.zip)
printf '{"version": "%s", "notes": "%s"}\n' "$VERSION" "${NOTES:-}" > ../app/version.json
echo "built $APP ($VERSION) → app/PushToIconik.zip + app/version.json"
