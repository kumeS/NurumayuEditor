# Homebrew Cask for NurumayuEditor.
#
# TEMPLATE — before this can be installed via `brew install`, you must:
#   1. Build a release bundle:  npm run tauri build   (produces a .dmg)
#   2. Upload the .dmg to a GitHub Release tagged v<version>.
#   3. Compute its checksum:    shasum -a 256 "NurumayuEditor_<version>_aarch64.dmg"
#      and paste it into `sha256` below (replace :no_check).
#   4. Host this cask in a tap, e.g.  kumeS/homebrew-tap, then:
#         brew tap kumeS/tap
#         brew install --cask nurumayufacet
#
# NOTE: an unsigned / un-notarized .app is quarantined by Gatekeeper. Either
# sign + notarize the build, or users must run:
#   xattr -dr com.apple.quarantine "/Applications/NurumayuEditor.app"
cask "nurumayufacet" do
  version "1.3.0"
  sha256 :no_check # replace with the real sha256 of the released .dmg

  url "https://github.com/kumeS/NurumayuFacet/releases/download/v#{version}/NurumayuEditor_#{version}_aarch64.dmg"
  name "NurumayuEditor"
  desc "Writing app where every document is already a slide deck"
  homepage "https://github.com/kumeS/NurumayuFacet"

  depends_on macos: :big_sur

  app "NurumayuEditor.app"

  # The bundle identifier is intentionally unchanged from earlier versions
  # (com.aix.texteditor), so on-disk state keeps its old paths.
  zap trash: [
    "~/Library/Application Support/com.aix.texteditor",
    "~/Library/Preferences/com.aix.texteditor.plist",
    "~/Library/Saved Application State/com.aix.texteditor.savedState",
  ]
end
