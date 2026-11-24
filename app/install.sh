#!/bin/bash
# Push to Iconik installer / updater (Jomboy Media).
#   curl -fsSL https://robsjomboy.github.io/Iconik-Autofill/app/install.sh | bash
# Puts "Push to Iconik.app" in /Applications (or ~/Applications), adds a Desktop icon, and opens it.
set -euo pipefail
ZIP_URL="https://robsjomboy.github.io/Iconik-Autofill/app/PushToIconik.zip"
APP="Push to Iconik.app"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "Downloading Push to Iconik…"
curl -fsSL "$ZIP_URL" -o "$TMP/app.zip"
ditto -x -k "$TMP/app.zip" "$TMP/x"
[ -d "$TMP/x/$APP" ] || { echo "The download didn't contain the app." >&2; exit 1; }
DEST=/Applications
if [ ! -w "$DEST" ]; then DEST="$HOME/Applications"; mkdir -p "$DEST"; fi
# Quit the running copy first (an update is started from inside the app).
osascript -e 'tell application id "com.jomboymedia.pushtoiconik" to quit' >/dev/null 2>&1 || true
sleep 1; pkill -f "$APP/Contents/MacOS/PushToIconik" 2>/dev/null || true; sleep 0.5
rm -rf "$DEST/$APP"
mv "$TMP/x/$APP" "$DEST/"
xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true
ln -sfn "$DEST/$APP" "$HOME/Desktop/Push to Iconik"
VER=$(defaults read "$DEST/$APP/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "?")
echo "Installed Push to Iconik $VER in $DEST, with an icon on your Desktop."
open "$DEST/$APP"
