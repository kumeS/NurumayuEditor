# Release notes

Japanese version: [README.md](README.md)

Every time a fix or a feature is made, bump the version and add release notes to this folder. Write the release notes in two languages, Japanese and English.

## Steps

1. Bump the version. Keep the same value in three places.
   - `package.json` (`npm version <new version> --no-git-tag-version` also updates `package-lock.json`)
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml` (running `cargo test --lib` also updates `Cargo.lock`)
2. Choosing the version
   - Bug fixes only: patch (for example 1.4.0 → 1.4.1)
   - Includes new features: minor (for example 1.4.0 → 1.5.0)
   - Incompatible changes (such as the file format): major
3. Write two release notes.
   - Japanese: `release-notes/v<version>.md`
   - English: `release-notes/v<version>.en.md`
4. Both must contain these three headings.
   - **What's updated** (**アップデート内容** in the Japanese version): what changed in this version (new features, bug fixes, behavior changes)
   - **Known Issues**: every defect and display problem known at that point. Keep the ones carried over from earlier versions, and remove the ones that were fixed
   - **Future Release**: features that are not built yet
5. Give each Known Issues and Future Release entry a number of the form `KI-01` or `FR-01`. The Japanese and English versions list the same numbered entries.
6. Add a `## v<version> — <date>` heading to `CHANGELOG.md` and move the "Unreleased" content under it.
7. Update the version shown in the README and the versions in `Casks/` and `Formula/`.

## Automated check

`src/releaseNotes.test.ts` checks the following. `npm test` fails if any of them does not hold.

- The version is the same in all three places
- Release notes for the current version exist in both Japanese and English, and each contains the three headings above
- The Japanese and English versions list the same Known Issues and Future Release numbers
- `CHANGELOG.md` has a heading for the current version
