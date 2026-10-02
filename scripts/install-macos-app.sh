#!/bin/bash
# Build NurumayuEditor and install it into /Applications (the copy Finder,
# Spotlight and the Dock launch). `tauri build` alone only writes to
# src-tauri/target/…, so without this step /Applications keeps an old build.
#
#   npm run install:app               # build, then install
#   npm run install:app -- --no-build # install the existing build
#
# The replaced app goes to the Trash (restorable). A running copy keeps running
# the old code until it is restarted.
set -euo pipefail
cd "$(dirname "$0")/.."

APP=NurumayuEditor.app
BIN=Contents/MacOS/nurumayueditor
BUILT="src-tauri/target/release/bundle/macos/$APP"
DEST="/Applications/$APP"

if [ "${1:-}" != "--no-build" ]; then
  # Build identity shown in Help (MISS-02; same rule as computeBuildId in
  # vite.config.ts): an explicit BUILD_ID wins, else the short git SHA plus
  # "-dirty" for uncommitted changes, else "unknown". Never aborts the build.
  if [ -z "${BUILD_ID:-}" ]; then
    BUILD_ID=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
    if [ "$BUILD_ID" != unknown ] && [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then
      BUILD_ID="$BUILD_ID-dirty"
    fi
  fi
  export BUILD_ID
  echo "🔖 Building $BUILD_ID"
  npx tauri build --bundles app
fi
[ -x "$BUILT/$BIN" ] || { echo "❌ No built app at $BUILT — run without --no-build."; exit 1; }

# Never install a build that predates the sources it should contain.
stale=$(find src src-tauri/src index.html -type f -newer "$BUILT/$BIN" | head -n 1)
if [ -n "$stale" ]; then
  echo "❌ The built app is older than the sources (e.g. $stale). Rebuild first."
  exit 1
fi

STAGE="/Applications/.$APP.installing"
rm -rf "$STAGE"
ditto "$BUILT" "$STAGE"
if [ -d "$DEST" ]; then
  BACKUP="$HOME/.Trash/NurumayuEditor-replaced-$(date +%Y%m%d-%H%M%S).app"
  mv "$DEST" "$BACKUP"
  echo "🗑  Previous app moved to the Trash: $(basename "$BACKUP")"
fi
mv "$STAGE" "$DEST"

if cmp -s "$BUILT/$BIN" "$DEST/$BIN"; then
  echo "✅ Installed $DEST ($(stat -f '%Sm' "$DEST/$BIN"))"
else
  echo "❌ Installed binary differs from the build output."
  exit 1
fi
if pgrep -f "$DEST/$BIN" >/dev/null; then
  echo "ℹ️  NurumayuEditor is running the previous version — quit and reopen it to use the new one."
fi
