# Homebrew formula — builds NurumayuFacet from source on the user's Mac.
# A local source build carries no `com.apple.quarantine` flag, so the app opens
# with no Gatekeeper / notarization prompt, and it targets the host CPU
# (Apple Silicon or Intel) automatically.
#
# This formula lives in the app's own public repo (kumeS/NurumayuFacet) under
# Formula/. Two ways to install it:
#
#   A) Single repo — no separate tap repo needed (two commands):
#        brew tap kumeS/tap https://github.com/kumeS/NurumayuFacet
#        brew install kumeS/tap/nurumayufacet
#
#   B) One command for anyone — needs a tap repo literally named
#      kumeS/homebrew-tap with this file in its Formula/ dir:
#        # then: brew install kumeS/tap/nurumayufacet   (no prior `brew tap`)
#
# After tagging a new release, refresh `sha256`:
#   curl -sL https://github.com/kumeS/NurumayuFacet/archive/refs/tags/vX.Y.Z.tar.gz | shasum -a 256
class Nurumayufacet < Formula
  desc "Writing app where every document is already a slide deck"
  homepage "https://github.com/kumeS/NurumayuFacet"
  url "https://github.com/kumeS/NurumayuFacet/archive/refs/tags/v1.3.0.tar.gz"
  # TODO(release): no v1.3.0 tag exists yet — this placeholder WILL fail
  # Homebrew's checksum check (intentionally, rather than installing the wrong
  # bytes). After tagging, regenerate with:
  #   curl -sL https://github.com/kumeS/NurumayuFacet/archive/refs/tags/v1.3.0.tar.gz | shasum -a 256
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "Artistic-2.0"
  head "https://github.com/kumeS/NurumayuFacet.git", branch: "main"

  depends_on "node" => :build
  depends_on "rust" => :build
  depends_on :macos

  def install
    # Keep package-manager caches inside the sandboxed build dir.
    ENV["CARGO_HOME"] = buildpath/".cargo"
    ENV["npm_config_cache"] = buildpath/".npm"

    system "npm", "ci"
    # Build only the .app — the .dmg step shells out to Finder/AppleScript,
    # which is unavailable in Homebrew's non-interactive sandbox.
    system "npx", "tauri", "build", "--bundles", "app"

    prefix.install "src-tauri/target/release/bundle/macos/NurumayuFacet.app"

    # Convenience CLI launcher: `nurumayufacet` opens the app.
    (bin/"nurumayufacet").write <<~SH
      #!/bin/bash
      exec open -a "#{opt_prefix}/NurumayuFacet.app" "$@"
    SH
  end

  def caveats
    <<~EOS
      NurumayuFacet was built from source — it has no quarantine flag and opens
      without any Gatekeeper / notarization prompt.

      Launch it:
        nurumayufacet
      …or add it to /Applications:
        ln -sfn #{opt_prefix}/NurumayuFacet.app /Applications/NurumayuFacet.app

      On first run, open Settings (gear icon, or Cmd-,) and paste your OpenRouter
      API key. It is stored in the macOS keychain, never on disk in plaintext.
    EOS
  end

  test do
    assert_path_exists prefix/"NurumayuFacet.app/Contents/MacOS/nurumayufacet"
  end
end
