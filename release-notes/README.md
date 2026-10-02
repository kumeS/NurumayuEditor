# リリースノート

English version: [README.en.md](README.en.md)

修正や機能追加を行うたびに、バージョンを上げて、このフォルダにリリースノートを追加する。リリースノートは日本語版と英語版の 2 つを作る。

## 手順

1. バージョンを上げる。3 か所を同じ値にする。
   - `package.json`（`npm version <新しいバージョン> --no-git-tag-version` で `package-lock.json` も更新される）
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`（`cargo test --lib` を実行すると `Cargo.lock` も更新される）
2. バージョンの決め方
   - 不具合の修正だけ：パッチ（例 1.4.0 → 1.4.1）
   - 機能の追加を含む：マイナー（例 1.4.0 → 1.5.0）
   - 互換性のない変更（ファイル形式など）：メジャー
3. リリースノートを 2 つ作る。
   - 日本語版：`release-notes/v<バージョン>.md`
   - 英語版：`release-notes/v<バージョン>.en.md`
4. どちらにも、次の 3 つの見出しを必ず入れる。
   - **アップデート内容**（英語版は **What's updated**）：このバージョンで何を変えたか（新機能、不具合の修正、動作の変更）
   - **Known Issues**：その時点で分かっている不具合と表示上の問題をすべて。前のバージョンから残っているものも載せ、直したものは外す
   - **Future Release**：まだ実装していない機能
5. Known Issues と Future Release の各項目には、`KI-01`、`FR-01` の形の番号を付ける。日本語版と英語版で同じ番号の項目を載せる。
6. `CHANGELOG.md` に `## v<バージョン> — <日付>` の見出しを作り、「Unreleased」の内容を移す。
7. README のバージョン表示と、`Casks/`・`Formula/` のバージョンを合わせる。

## 自動チェック

`src/releaseNotes.test.ts` が次を検査する。満たさないと `npm test` が失敗する。

- 3 か所のバージョンが一致している
- 現在のバージョンのリリースノートが日本語版・英語版ともにあり、それぞれ上の 3 つの見出しを含む
- 日本語版と英語版で、Known Issues と Future Release の番号が一致している
- `CHANGELOG.md` に現在のバージョンの見出しがある
