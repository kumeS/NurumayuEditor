#!/bin/bash
# Build the distributable DMG: npm run build:dmg
#
# Tauri's bundle_dmg.sh lays the DMG out by asking Finder for the disk named
# "NurumayuEditor". It fails ("error running bundle_dmg.sh") when a volume with
# that name is already mounted — typically a previously built DMG left open
# after installing from it — or when an earlier failed run left its work image
# mounted. Clear both first, then build.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME=NurumayuEditor
BUNDLE=src-tauri/target/release/bundle

# Eject stale mounts: our DMGs, their temporary rw.* work images, or any
# volume named like the app. hdiutil refuses to eject a volume that is in use,
# and we stop rather than force it.
hdiutil info | awk '
  /^image-path/ { img = substr($0, index($0, ":") + 2) }
  /\/Volumes\// { for (i = 1; i <= NF; i++) if ($i ~ /^\/Volumes\//) { v = $i; for (j = i + 1; j <= NF; j++) v = v " " $j; print img "\t" v } }
' | while IFS=$'\t' read -r image volume; do
  case "$image|$volume" in
    *"/bundle/dmg/${NAME}_"*.dmg\|* | *"/bundle/macos/rw."*.dmg\|* | *"|/Volumes/$NAME" | *"|/Volumes/$NAME "*)
      echo "⏏  Ejecting $volume (from $(basename "$image"))"
      hdiutil detach "$volume" || { echo "❌ Couldn't eject $volume — close anything using it, then retry."; exit 1; }
      ;;
  esac
done

rm -f "$BUNDLE"/macos/rw.*.dmg

npx tauri build --bundles dmg
ls -lh "$BUNDLE"/dmg/*.dmg
