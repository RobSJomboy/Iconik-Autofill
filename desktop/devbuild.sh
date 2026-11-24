#!/bin/bash
# Fast local build (this Mac's chip only) into build/dev for testing.
set -e; cd "$(dirname "$0")"
APP="build/dev/Push to Iconik.app"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -swift-version 5 -target arm64-apple-macos12 -o "$APP/Contents/MacOS/PushToIconik" main.swift
rm -rf "$APP/Contents/Resources/ui"; cp -R ui "$APP/Contents/Resources/ui"
cp "build/Push to Iconik.app/Contents/Info.plist" "$APP/Contents/" 2>/dev/null || true
cp "build/Push to Iconik.app/Contents/Resources/AppIcon.icns" "$APP/Contents/Resources/" 2>/dev/null || true
codesign --force --sign - "$APP" 2>/dev/null
